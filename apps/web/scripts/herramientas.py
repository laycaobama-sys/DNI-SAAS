"""Generates /herramientas (hub) and one indexable page per free tool from one template.

Run from apps/web:  python scripts/herramientas.py
The tool logic lives in packages/core/src/free-tools.ts (tested) and src/landing/tools.ts (browser).
Edit the texts here and re-run; the generated HTML files are committed.
"""
import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "herramientas"
OUT.mkdir(exist_ok=True)

HEAD = """<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content="{desc}" />
    <link rel="canonical" href="__SITE_URL__{path}" />
    <meta name="theme-color" content="#0b0b0c" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="/src/landing/landing.css" />
    <link rel="stylesheet" href="/src/landing/legal.css" />
    <link rel="stylesheet" href="/src/landing/tools.css" />
    {script}
    <script type="application/ld+json">{ld}</script>
  </head>
  <body>
    <a class="skip" href="#main">Saltar al contenido</a>
    <header class="nav is-solid"><a class="brand" href="/" aria-label="DNI Growth, inicio"><span class="brand-mark" aria-hidden="true">DNI</span><span class="brand-word">Growth</span></a><a class="btn" href="/#auditar">Auditar mi web gratis</a></header>
    <main id="main" class="legal tools"{data}>
{body}
    </main>
    <nav class="legal-foot" aria-label="Más páginas">
      <a href="/">Inicio</a>
      <a href="/herramientas"{cur}>Herramientas gratuitas</a>
      <a href="/precios">Precios</a>
      <a href="/blog">Blog</a>
      <a href="/seguridad">Seguridad</a>
      <a href="/estado">Estado del servicio</a>
      <a href="/legal/privacidad">Privacidad</a>
      <a href="/legal/condiciones">Condiciones de uso</a>
    </nav>
  </body>
</html>
"""

CTA = """      <aside class="tool-cta">
        <h2>¿Quieres la revisión completa de tu web?</h2>
        <p>La auditoría gratuita de DNI Growth revisa hasta 5 páginas públicas de tu web: SEO técnico, metadatos, datos estructurados y si los buscadores con IA pueden leerla. Sin tarjeta y sin registro.</p>
        <p><a class="btn btn-accent" href="/#auditar">Auditar mi web gratis</a></p>
      </aside>"""

PRIVACY = '<p class="tool-note">Funciona en tu navegador: lo que escribes o pegas aquí no se envía a DNI Growth ni a nadie.</p>'

TOOLS = [
    {
        "slug": "robots-txt-bots-ia",
        "title": "Comprobador de robots.txt y bots de IA",
        "desc": "Pega tu robots.txt y comprueba gratis si GPTBot, ClaudeBot, PerplexityBot, Google-Extended y Googlebot pueden leer tu web. Sin registro.",
        "lead": "Pega el contenido de tu archivo robots.txt (lo ves en tuweb.com/robots.txt) y te decimos, bot por bot, si los buscadores y asistentes con IA pueden leer tu página principal.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="robots">Contenido de robots.txt</label>
        <textarea id="robots" name="robots" rows="10" spellcheck="false" placeholder="User-agent: *&#10;Disallow: /wp-admin/&#10;Sitemap: https://tuweb.com/sitemap.xml"></textarea>
        <button class="btn btn-accent" type="submit">Comprobar</button>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Cómo leerlo</h2>
      <p>Cada empresa de IA usa bots distintos para cosas distintas. Bloquear el bot de <strong>entrenamiento</strong> (por ejemplo GPTBot o ClaudeBot) no impide que aparezcas en sus <strong>búsquedas</strong>, que usan otros bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot). Si quieres que te citen, deja pasar los de búsqueda.</p>
      <p>Google-Extended solo controla si Google usa tu contenido en Gemini; no cambia tu posición en Google Search, que depende de Googlebot.</p>
      <p>Seguimos el estándar RFC 9309: gana el grupo de reglas más específico para cada bot y, dentro de él, la regla más larga que coincide. robots.txt es una petición, no una barrera: los bots respetuosos la cumplen, pero no protege contenido privado.</p>""",
        "faq": [
            ("¿Bloquear GPTBot me quita de ChatGPT?", "No necesariamente. GPTBot es el bot de entrenamiento. Las búsquedas de ChatGPT usan OAI-SearchBot y, cuando una persona pide abrir tu página, ChatGPT-User."),
            ("¿Dónde está mi robots.txt?", "Siempre en la raíz del dominio: https://tuweb.com/robots.txt. Si no existe, todos los bots pueden leer toda la web."),
        ],
    },
    {
        "slug": "generador-llms-txt",
        "title": "Generador de llms.txt gratis",
        "desc": "Crea gratis el archivo llms.txt de tu web: un resumen en Markdown con tus páginas clave para que los asistentes de IA entiendan tu negocio.",
        "lead": "llms.txt es un archivo de texto en la raíz de tu web que resume quién eres y enlaza tus páginas más importantes, en un formato fácil de leer para los modelos de lenguaje.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="name">Nombre de tu empresa o web</label>
        <input id="name" name="name" maxlength="120" required />
        <label for="summary">Resumen en una frase</label>
        <input id="summary" name="summary" maxlength="300" required placeholder="Panadería artesana en Valencia con obrador propio y envío a domicilio." />
        <label for="details">Más contexto (opcional)</label>
        <textarea id="details" name="details" rows="3" maxlength="1500" placeholder="Horario, zona de reparto, qué te diferencia…"></textarea>
        <label for="links">Páginas clave: una por línea, «Título | https://dirección | nota opcional»</label>
        <textarea id="links" name="links" rows="6" spellcheck="false" placeholder="Precios | https://tuweb.com/precios | tarifas con IVA&#10;Contacto | https://tuweb.com/contacto"></textarea>
        <button class="btn btn-accent" type="submit">Generar llms.txt</button>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Qué hacer con el archivo</h2>
      <p>Guárdalo como <code>llms.txt</code> y súbelo a la raíz de tu dominio para que esté en <code>https://tuweb.com/llms.txt</code>. En WordPress puedes subirlo por FTP o con el gestor de archivos de tu alojamiento.</p>
      <p>Es una propuesta abierta (llmstxt.org), no un estándar oficial: no garantiza que ningún asistente te cite. Ayuda a que, cuando un asistente lea tu web, entienda rápido qué ofreces y dónde está cada cosa. Incluye solo páginas públicas y con información verdadera.</p>""",
        "faq": [
            ("¿Sustituye al sitemap?", "No. El sitemap lista todas las páginas para los buscadores; llms.txt resume las más importantes para los asistentes de IA. Conviene tener los dos."),
            ("¿Cada cuánto lo actualizo?", "Cuando cambien tus páginas clave, tus precios o tus servicios."),
        ],
    },
    {
        "slug": "generador-schema",
        "title": "Generador de datos estructurados JSON-LD",
        "desc": "Genera gratis el JSON-LD de tu organización, negocio local o artículo para Google y los buscadores con IA, con comprobaciones antes de pegarlo.",
        "lead": "Los datos estructurados describen tu negocio en un formato que entienden Google y los asistentes con IA: nombre, dirección, teléfono, redes o los datos de un artículo.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="type">Tipo</label>
        <select id="type" name="type"><option value="LocalBusiness">Negocio local</option><option value="Organization">Organización / empresa online</option><option value="Article">Artículo</option></select>
        <label for="name">Nombre (o título del artículo)</label>
        <input id="name" name="name" maxlength="160" required />
        <label for="url">Dirección de la página</label>
        <input id="url" name="url" type="url" placeholder="https://tuweb.com" required />
        <label for="description">Descripción breve</label>
        <input id="description" name="description" maxlength="300" />
        <div class="tool-grid" data-only="LocalBusiness Organization">
          <div><label for="logo">Logo (https://…)</label><input id="logo" name="logo" type="url" /></div>
          <div><label for="phone">Teléfono</label><input id="phone" name="phone" maxlength="30" /></div>
        </div>
        <div class="tool-grid" data-only="LocalBusiness">
          <div><label for="street">Calle y número</label><input id="street" name="street" maxlength="160" /></div>
          <div><label for="city">Ciudad</label><input id="city" name="city" maxlength="80" /></div>
          <div><label for="postalCode">Código postal</label><input id="postalCode" name="postalCode" maxlength="10" /></div>
        </div>
        <div data-only="LocalBusiness Organization"><label for="sameAs">Perfiles oficiales (uno por línea, https://…)</label><textarea id="sameAs" name="sameAs" rows="3" spellcheck="false"></textarea></div>
        <div class="tool-grid" data-only="Article">
          <div><label for="author">Autor</label><input id="author" name="author" maxlength="80" /></div>
          <div><label for="datePublished">Fecha de publicación</label><input id="datePublished" name="datePublished" type="date" /></div>
          <div><label for="image">Imagen (https://…)</label><input id="image" name="image" type="url" /></div>
        </div>
        <button class="btn btn-accent" type="submit">Generar JSON-LD</button>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Dónde pegarlo</h2>
      <p>Pega el bloque <code>&lt;script type="application/ld+json"&gt;</code> dentro del <code>&lt;head&gt;</code> de la página que describe (la portada para tu negocio, cada artículo para el suyo). Después compruébalo con la Prueba de resultados enriquecidos de Google.</p>
      <p>Pon solo datos que también se vean en la página y que sean verdad: Google puede ignorar o penalizar marcado que no coincide con el contenido visible.</p>""",
        "faq": [
            ("¿Esto me hace subir en Google?", "No directamente. Ayuda a que los buscadores entiendan tu página y puede habilitar resultados enriquecidos, pero no garantiza posiciones."),
            ("¿Negocio local u organización?", "Negocio local si atiendes en una dirección física o en una zona concreta; organización si eres una empresa online sin atención presencial."),
        ],
    },
    {
        "slug": "generador-faq-aeo",
        "title": "Generador de preguntas frecuentes (FAQ) para AEO",
        "desc": "Convierte tus preguntas y respuestas en un bloque HTML accesible y su marcado FAQPage para buscadores y asistentes con IA. Gratis y sin registro.",
        "lead": "Las preguntas frecuentes bien escritas responden exactamente lo que la gente pregunta a Google o a ChatGPT. Escribe las tuyas y te damos el HTML y el marcado FAQPage.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="faq">Preguntas y respuestas: la pregunta en una línea que empiece por «P:» y la respuesta debajo con «R:»</label>
        <textarea id="faq" name="faq" rows="10" placeholder="P: ¿Hacéis envíos a domicilio?&#10;R: Sí, en Valencia capital de martes a sábado.&#10;P: ¿Tenéis pan sin gluten?&#10;R: Sí, los viernes, por encargo."></textarea>
        <button class="btn btn-accent" type="submit">Generar FAQ</button>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Cómo escribir buenas respuestas</h2>
      <ul>
        <li>Responde en la primera frase y añade el detalle después.</li>
        <li>Usa las palabras que usan tus clientes (las ves en Search Console o en lo que te preguntan por teléfono).</li>
        <li>Una pregunta por tema; nada de repetir la misma con otras palabras.</li>
        <li>Las preguntas tienen que verse en la página, no solo en el marcado.</li>
      </ul>
      <p>Google muestra hoy los resultados enriquecidos de FAQ sobre todo para webs oficiales de salud y gobierno, pero el bloque sigue siendo útil para tus visitantes y para que los asistentes con IA encuentren respuestas claras.</p>""",
        "faq": [
            ("¿Cuántas preguntas pongo?", "Entre 4 y 10 suele bastar. Mejor pocas y útiles que muchas de relleno."),
        ],
    },
    {
        "slug": "vista-previa-google",
        "title": "Vista previa del resultado en Google (título y meta descripción)",
        "desc": "Comprueba gratis cómo se verá tu título y tu meta descripción en Google y si se cortan por longitud, medido en píxeles como lo hace el buscador.",
        "lead": "Google corta el título y la descripción por anchura en píxeles, no por número de letras. Escribe los tuyos y mira cómo quedarían.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="title">Título (etiqueta &lt;title&gt;)</label>
        <input id="title" name="title" maxlength="200" />
        <label for="url">Dirección</label>
        <input id="url" name="url" type="url" placeholder="https://tuweb.com/pagina" />
        <label for="description">Meta descripción</label>
        <textarea id="description" name="description" rows="3" maxlength="400"></textarea>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Qué tener en cuenta</h2>
      <p>Como referencia, el título se corta alrededor de 580 píxeles y la descripción alrededor de 920 en ordenador. Pon lo importante al principio: el servicio, la ciudad o lo que te diferencia.</p>
      <p>Google puede reescribir tu título o tu descripción si cree que otra parte de la página responde mejor a la búsqueda. Esta vista previa es una aproximación, no una garantía de cómo aparecerás.</p>""",
        "faq": [
            ("¿La meta descripción influye en el posicionamiento?", "No directamente, pero una buena descripción ayuda a que la gente haga clic."),
        ],
    },
    {
        "slug": "comprobador-sitemap",
        "title": "Comprobador de sitemap.xml",
        "desc": "Pega tu sitemap.xml y detecta gratis direcciones repetidas, sin https, de otros dominios, fechas lastmod mal escritas y límites superados.",
        "lead": "El sitemap le dice a Google qué páginas tienes. Pega su contenido (lo ves en tuweb.com/sitemap.xml) y revisamos los errores más comunes.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="xml">Contenido de sitemap.xml</label>
        <textarea id="xml" name="xml" rows="10" spellcheck="false" placeholder="&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?&gt;&#10;&lt;urlset xmlns=&quot;http://www.sitemaps.org/schemas/sitemap/0.9&quot;&gt;…"></textarea>
        <button class="btn btn-accent" type="submit">Comprobar</button>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Las reglas básicas</h2>
      <ul>
        <li>Máximo 50.000 direcciones y 50 MB por archivo; si tienes más, usa un índice de sitemaps.</li>
        <li>Solo páginas de tu dominio, con https y que respondan bien (sin redirecciones ni errores 404).</li>
        <li><code>lastmod</code> en formato AAAA-MM-DD y solo si es la fecha real del último cambio.</li>
        <li>Avisa a Google enviándolo en Search Console y enlázalo desde robots.txt.</li>
      </ul>""",
        "faq": [
            ("¿Esto comprueba si mis páginas funcionan?", "No: revisa el archivo que pegas. Para comprobar que cada página responde bien, usa la auditoría gratuita."),
        ],
    },
    {
        "slug": "etiquetas-open-graph",
        "title": "Generador de etiquetas Open Graph para redes sociales",
        "desc": "Genera gratis las etiquetas Open Graph y de X (Twitter) para que tu página se vea bien al compartirla en WhatsApp, LinkedIn y Facebook.",
        "lead": "Cuando alguien comparte tu página, WhatsApp, LinkedIn o Facebook leen estas etiquetas para mostrar el título, la descripción y la imagen.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <label for="title">Título</label>
        <input id="title" name="title" maxlength="120" />
        <label for="description">Descripción</label>
        <input id="description" name="description" maxlength="300" />
        <label for="url">Dirección de la página</label>
        <input id="url" name="url" type="url" placeholder="https://tuweb.com/pagina" />
        <label for="image">Imagen (https://…, 1200×630 px recomendado)</label>
        <input id="image" name="image" type="url" />
        <label for="siteName">Nombre del sitio</label>
        <input id="siteName" name="siteName" maxlength="80" />
        <button class="btn btn-accent" type="submit">Generar etiquetas</button>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>Consejos</h2>
      <p>Usa una imagen de 1200×630 píxeles en JPG o PNG, de menos de 5 MB, con el texto importante en el centro (algunas apps recortan los bordes). Pega las etiquetas en el <code>&lt;head&gt;</code> de la página. Las redes guardan la vista previa en caché: si cambias la imagen, puede tardar en actualizarse.</p>""",
        "faq": [
            ("¿WordPress ya las pone?", "Muchos temas y plugins de SEO (como Yoast o Rank Math) las generan solos. Revisa que no queden duplicadas."),
        ],
    },
    {
        "slug": "calculadora-valor-trafico",
        "title": "Calculadora del valor de tu tráfico orgánico",
        "desc": "Calcula gratis cuánto te costaría conseguir con anuncios de Google las visitas que ya te llegan desde el buscador. Una estimación clara, sin registro.",
        "lead": "Una forma sencilla de poner en euros tu posicionamiento: cuánto pagarías en anuncios por las mismas visitas que hoy recibes gratis desde Google.",
        "ui": """      <form class="tool-form" data-form novalidate>
        <div class="tool-grid">
          <div><label for="visits">Visitas orgánicas al mes</label><input id="visits" name="visits" type="number" min="0" step="1" inputmode="numeric" /></div>
          <div><label for="cpc">Coste por clic medio en tu sector (€)</label><input id="cpc" name="cpc" type="number" min="0" step="0.01" inputmode="decimal" /></div>
        </div>
      </form>
      <div class="tool-out" data-out aria-live="polite"></div>""",
        "how": """      <h2>De dónde saco los datos</h2>
      <p>Las visitas orgánicas las ves en Google Search Console (Rendimiento → clics) o en Google Analytics. El coste por clic de tus palabras clave lo da el Planificador de palabras clave de Google Ads.</p>
      <p>Es una <strong>estimación</strong>: no todas las visitas orgánicas tendrían el mismo coste en anuncios, ni todas convierten igual. Sirve para comparar, no como cifra exacta.</p>""",
        "faq": [
            ("¿Por qué el resultado es una estimación?", "Porque multiplica dos medias. El valor real depende de qué búsquedas te traen cada visita y de cuántas acaban en venta."),
        ],
    },
]


def ld(tool_name, desc, path, faq):
    graph = [
        {
            "@type": "WebApplication",
            "name": tool_name,
            "description": desc,
            "url": f"__SITE_URL__{path}",
            "applicationCategory": "BusinessApplication",
            "operatingSystem": "Cualquiera (navegador)",
            "inLanguage": "es-ES",
            "isAccessibleForFree": True,
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
            "publisher": {"@type": "Organization", "@id": "__SITE_URL__/#organization", "name": "DNI Growth", "url": "__SITE_URL__/"},
        },
        {
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Inicio", "item": "__SITE_URL__/"},
                {"@type": "ListItem", "position": 2, "name": "Herramientas gratuitas", "item": "__SITE_URL__/herramientas"},
                {"@type": "ListItem", "position": 3, "name": tool_name, "item": f"__SITE_URL__{path}"},
            ],
        },
    ]
    if faq:
        graph.append({"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]})
    return json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace("<", "\\u003c")


for t in TOOLS:
    path = f"/herramientas/{t['slug']}"
    faq_html = "\n".join(f"        <details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>" for q, a in t["faq"])
    body = f"""      <p class="tool-crumbs"><a href="/herramientas">← Herramientas gratuitas</a></p>
      <h1>{html.escape(t['title'])}</h1>
      <p class="lead-in">{html.escape(t['lead'])}</p>
      {PRIVACY}
{t['ui']}
{t['how']}
      <h2>Preguntas frecuentes</h2>
      <div class="tool-faq">
{faq_html}
      </div>
{CTA}"""
    page = HEAD.format(
        title=html.escape(f"{t['title']} · DNI Growth"),
        desc=html.escape(t["desc"]),
        path=path,
        script='<script type="module" src="/src/landing/tools.ts"></script>',
        ld=ld(t["title"], t["desc"], path, t["faq"]),
        data=f' data-tool="{t["slug"]}"',
        body=body,
        cur="",
    )
    (OUT / f"{t['slug']}.html").write_text(page, encoding="utf-8", newline="\n")

cards = "\n".join(
    f'        <li><article><h2><a href="/herramientas/{t["slug"]}">{html.escape(t["title"])}</a></h2><p>{html.escape(t["desc"])}</p></article></li>' for t in TOOLS
)
hub_body = f"""      <h1>Herramientas SEO y GEO gratuitas</h1>
      <p class="lead-in">Herramientas sencillas para revisar y preparar tu web para Google y para los buscadores con IA. Gratis, sin registro y sin enviar tus datos: funcionan en tu navegador.</p>
      <ul class="blog-list tool-list">
{cards}
      </ul>
{CTA}"""
hub_ld = json.dumps(
    {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "Herramientas SEO y GEO gratuitas",
        "url": "__SITE_URL__/herramientas",
        "inLanguage": "es-ES",
        "hasPart": [{"@type": "WebApplication", "name": t["title"], "url": f"__SITE_URL__/herramientas/{t['slug']}"} for t in TOOLS],
        "publisher": {"@type": "Organization", "@id": "__SITE_URL__/#organization", "name": "DNI Growth", "url": "__SITE_URL__/"},
    },
    ensure_ascii=False,
)
(ROOT / "herramientas.html").write_text(
    HEAD.format(
        title="Herramientas SEO y GEO gratuitas · DNI Growth",
        desc="Herramientas gratuitas para tu web: robots.txt y bots de IA, llms.txt, datos estructurados, FAQ, vista previa en Google, sitemap, Open Graph y valor del tráfico.",
        path="/herramientas",
        script="",
        ld=hub_ld,
        data="",
        body=hub_body.replace('class="legal tools"', ""),
        cur=' aria-current="page"',
    ).replace('class="legal tools"', 'class="legal tools blog"'),
    encoding="utf-8",
    newline="\n",
)
print("ok", len(TOOLS))
