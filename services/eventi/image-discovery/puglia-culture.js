import * as cheerio from 'cheerio';

const DOMAIN = 'www.pugliaculture.it';

// Supporta HTML originale e sorgente salvato da Chrome.
function loadHtml(html) {
  const $ = cheerio.load(html);

  if ($('td.line-content').length) {
    const original = $('td.line-content')
      .map((i, e) => $(e).text())
      .get()
      .join('\n');

    return cheerio.load(original);
  }

  return $;
}

// Accetta esclusivamente URL HTTPS del dominio ufficiale.
function resolveUrl(value, base) {
  try {
    if (!value) return null;

    const url = new URL(value, base);

    if (
      url.protocol !== 'https:' ||
      url.hostname !== DOMAIN ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }

    url.hash = '';

    return url.href;

  } catch {
    return null;
  }
}

// Estrae i collegamenti alle singole schede degli spettacoli.
export function extractEventLinks(html, pageUrl) {
  const $ = loadHtml(html);
  const events = new Map();

  $('a[href]').each((_, element) => {
    const url = resolveUrl(
      $(element).attr('href'),
      pageUrl
    );

    if (!url) return;

    if (!new URL(url).pathname.startsWith('/evento/')) {
      return;
    }

    const title = $(element).text().trim();

    if (
      !events.has(url) ||
      title.length > events.get(url).titolo.length
    ) {
      events.set(url, {
        titolo: title,
        paginaUrl: url
      });
    }
  });

  return [...events.values()];
}

// Estrae le immagini candidate dalla scheda dello spettacolo.
export function extractEventImages(html, pageUrl) {
  const $ = loadHtml(html);

  const title = $('h1').first().text().trim();

  const images = new Map();

  function add(value, method) {
    const url = resolveUrl(value, pageUrl);

    if (!url || images.has(url)) return;

    images.set(url, {
      titolo: title,
      paginaUrl: pageUrl,
      immagineUrl: url,
      metodo: method
    });
  }

  // Analizza i dati strutturati JSON-LD.
  function walk(value) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    const types = [value['@type']].flat();

    if (
      types.some(t =>
        typeof t === 'string' &&
        t.endsWith('Event')
      )
    ) {
      for (const image of [value.image].flat()) {
        add(
          typeof image === 'string'
            ? image
            : image?.url || image?.contentUrl,
          'JSON_LD'
        );
      }
    }

    Object.values(value).forEach(walk);
  }

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).text()));
    } catch {}
  });

  // Immagine Open Graph.
  add(
    $('meta[property="og:image"]').attr('content'),
    'OG_IMAGE'
  );

  // Immagine Twitter.
  add(
    $('meta[name="twitter:image"]').attr('content'),
    'TWITTER_IMAGE'
  );

  return {
    titolo: title,
    paginaUrl: pageUrl,
    immagini: [...images.values()]
  };
}