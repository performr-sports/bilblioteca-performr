// ─────────────────────────────────────────────────────────────────────────────
// Performr Biblioteca — Netlify Function
// Actúa de puente entre la biblioteca HTML y la base de datos de Notion.
// La API key de Notion queda segura en las variables de entorno de Netlify.
// ─────────────────────────────────────────────────────────────────────────────

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Lee el texto plano de un campo rich_text de Notion
function getText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return prop.title.map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('');
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'checkbox') return prop.checkbox;
  return '';
}

// Consulta todas las páginas de la base de datos (maneja paginación automática)
async function queryDatabase(databaseId, token) {
  let results = [];
  let cursor = undefined;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

// Transforma una página de Notion en el formato que espera la biblioteca
function mapPage(page) {
  const p = page.properties;
  return {
    titulo:      getText(p['Titulo']),
    categoria:   getText(p['Categoria']),
    tipo:        getText(p['Tipo']),
    descripcion: getText(p['Descripcion']),
    grupo:       getText(p['Grupo']),
    contenido:   getText(p['Contenido']),
    activo:      getText(p['Activo']),
  };
}

// Normaliza texto eliminando tildes y pasando a minúsculas
function normalize(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_\s]+/g, '-').trim();
}

// Categorías: Notion sin tilde → display con tilde
const CAT_CANONICAL = {
  'recuperacion': 'Recuperación',
  'nutricion':    'Nutrición',
  'rendimiento':  'Rendimiento',
  'bienestar':    'Bienestar',
  'rutinas':      'Rutinas',
  'performr':     'Performr',
};

// Tipos: Notion sin tilde → clave interna del HTML
const TIPO_CANONICAL = {
  'tip':          'tip',
  'tecnica':      'tecnica',
  'herramienta':  'herramienta',
  'protocolo':    'protocolo',
  'guia':         'guia',
  'mito':         'mito',
  'calculadora':  'calculadora',
  'score':        'score',
  'rutina':       'rutina',
  'como-mejorar': 'como-mejorar',
};

function canonicalCat(name) {
  return CAT_CANONICAL[normalize(name)] || name;
}

function canonicalTipo(name) {
  return TIPO_CANONICAL[normalize(name)] || normalize(name);
}

// Agrupa los recursos por categoría y grupo (para Performr)
function buildData(items) {
  // Solo los activos
  const active = items.filter(i => i.activo === true && i.titulo);

  // Orden de categorías
  const catOrder = ['Recuperación', 'Nutrición', 'Rendimiento', 'Bienestar', 'Rutinas', 'Performr'];
  const byCategory = {};

  active.forEach(item => {
    const cat = canonicalCat(item.categoria) || 'Sin categoría';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  });

  // Armamos la estructura final
  const result = catOrder
    .filter(cat => byCategory[cat])
    .map(cat => {
      const recursos = byCategory[cat];

      // Performr tiene grupos — el resto es lista plana
      if (cat === 'Performr') {
        const grupoOrder = ['Scores principales', 'Estado físico y mental', 'Métricas fisiológicas', 'Sueño'];
        const byGrupo = {};
        recursos.forEach(r => {
          const g = r.grupo || 'General';
          if (!byGrupo[g]) byGrupo[g] = [];
          byGrupo[g].push(formatRecurso(r));
        });

        const grupos = grupoOrder
          .filter(g => byGrupo[g])
          .map(g => ({ label: g, recursos: byGrupo[g] }));

        // Grupos extra que no están en el orden predefinido
        Object.keys(byGrupo).forEach(g => {
          if (!grupoOrder.includes(g)) {
            grupos.push({ label: g, recursos: byGrupo[g] });
          }
        });

        return { categoria: cat, esScores: true, grupos };
      }

      // Categorías con grupos opcionales
      const tieneGrupos = recursos.some(r => r.grupo);
      if (tieneGrupos) {
        const byGrupo = {};
        recursos.forEach(r => {
          const g = r.grupo || 'General';
          if (!byGrupo[g]) byGrupo[g] = [];
          byGrupo[g].push(formatRecurso(r));
        });
        return {
          categoria: cat,
          esScores: true,
          grupos: Object.keys(byGrupo).map(g => ({ label: g, recursos: byGrupo[g] }))
        };
      }

      return { categoria: cat, recursos: recursos.map(formatRecurso) };
    });

  return result;
}

// Detecta si el contenido tiene URL de imagen o YouTube
function parseContenido(texto) {
  if (!texto) return { extra: undefined, video: undefined, imagen: undefined };
  const lines = texto.split(/\n/);
  let video, imagen, extraLines = [];
  lines.forEach(line => {
    const t = line.trim();
    const yt = t.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]+)/);
    if (yt) { video = yt[1]; return; }
    if (t.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i) || t.match(/^https?:\/\/.*\.(jpg|jpeg|png|gif|webp)/i)) {
      imagen = t; return;
    }
    extraLines.push(line);
  });
  const extra = extraLines.join('\n').trim() || undefined;
  return { extra, video, imagen };
}

function formatRecurso(r) {
  const { extra, video, imagen } = parseContenido(r.contenido);
  return {
    tipo:   canonicalTipo(r.tipo),
    titulo: r.titulo,
    desc:   r.descripcion,
    extra,
    video,
    imagen,
  };
}

// ─── Handler principal ────────────────────────────────────────────────────────
exports.handler = async function(event, context) {
  // CORS — permite que el HTML en cualquier dominio haga el fetch
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const token    = process.env.NOTION_TOKEN;
  const dbId     = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Variables de entorno NOTION_TOKEN o NOTION_DATABASE_ID no configuradas.' }),
    };
  }

  try {
    const pages = await queryDatabase(dbId, token);
    const items = pages.map(mapPage);
    const data  = buildData(items);

    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=60' }, // cache 1 min
      body: JSON.stringify({ data }),
    };
  } catch (err) {
    console.error('Error fetching Notion:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
