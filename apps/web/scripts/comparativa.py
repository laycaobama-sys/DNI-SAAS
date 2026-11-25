"""Generates /comparativa/babylovegrowth.

Run from apps/web:  python scripts/comparativa.py
Rules: only facts published by each company on its own pages, with the date checked and the source URL;
respectful tone; say where the other product is ahead. Re-check every fact before changing CHECKED.
"""
import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
(ROOT / "comparativa").mkdir(exist_ok=True)

CHECKED = "25 de noviembre de 2026"
CHECKED_ISO = "2026-11-25"
BLG = "https://www.babylovegrowth.ai"
SRC = {
    "pricing": f"{BLG}/pricing",
    "home": f"{BLG}/",
    "terms": f"{BLG}/en/terms-and-conditions",
    "backlinks": f"{BLG}/en/backlinks",
    "privacy": f"{BLG}/en/privacy-policy",
}
GOOGLE_SPAM = "https://developers.google.com/search/docs/essentials/spam-policies#link-spam"


def src(key, label="fuente"):
    return f'<a href="{SRC[key]}" rel="nofollow noopener noreferrer" target="_blank">{label}</a>'


# (topic, BabyLoveGrowth, DNI Growth). HTML allowed: written here, never from user input.
ROWS = [
    ("Precio", f"Grow 99 €/mes y Scale 399 €/mes. Su página de precios no indica si incluye IVA ({src('pricing')}).", 'Free 0 €, Starter 49 €, Growth 129 €, Pro 249 € y Agency 449 € al mes, sin IVA (<a href="/precios">precios</a>).'),
    ("Prueba", f"3 días ({src('pricing')}).", "Plan Free sin tarjeta y 7 días de prueba de Growth (con tarjeta, sin cobro hasta el día 8)."),
    ("Garantía", f"90 días: si el tráfico o el Domain Rating no mejoran, con solicitud en los 14 días siguientes ({src('terms', 'condiciones, apartado 8')}).", 'Garantía de 90 días en Growth, Pro y Agency, con requisitos medibles (<a href="/legal/garantia">garantía</a>).'),
    ("Empresa y ley aplicable", f"BLG INC., con dirección en San Rafael, California (EE. UU.); sus condiciones se rigen por la ley del Reino Unido ({src('terms', 'condiciones, apartado 11')}).", 'Titular en España; condiciones bajo la ley española. Base de datos en la jurisdicción de la UE; algunos proveedores tratan datos fuera del EEE (<a href="/subencargados">subencargados</a>).'),
    ("Enlaces", f"Red de intercambio de enlaces entre clientes: cada cliente de la red publica artículos con enlaces a otros clientes ({src('backlinks')}).", f'No usamos redes de intercambio de enlaces. Proponemos oportunidades de autoridad que una persona revisa. Google considera los intercambios excesivos de enlaces una forma de spam (<a href="{GOOGLE_SPAM}" rel="noopener noreferrer" target="_blank">políticas de Google</a>).'),
    ("Imágenes creadas con IA", f"Indican que quitan los metadatos de las imágenes que generan, incluidas las credenciales de contenido C2PA, para que las plataformas no las etiqueten como IA ({src('home', 'portada')}).", "Cada imagen que genera DNI Growth lleva la marca estándar IPTC «creada por un modelo de IA» en sus metadatos, que plataformas como Meta y Google pueden leer."),
    ("Revisión antes de publicar", f"Puntuación automática de calidad de 0 a 100 ({src('pricing')}). No encontramos descrito un paso de revisión humana obligatorio.", "Nada se publica sin la aprobación de una persona con permiso; cada aprobación queda registrada."),
    ("Publicación en tu web", f"WordPress, Shopify, Webflow, Wix y más, y cualquier CMS por API ({src('pricing')}).", "WordPress desde Starter. Shopify, Ghost y Webflow en desarrollo; mientras, exportación HTML o Markdown."),
    ("Visibilidad en asistentes de IA", f"ChatGPT, Claude y Gemini; 10 o 50 preguntas en seguimiento diario según el plan ({src('pricing')}).", "Gemini por muestreo, de 10 a 100 preguntas según el plan. ChatGPT, Claude y Perplexity, cuando estén conectados."),
    ("Idiomas del contenido", f"Más de 50 idiomas ({src('pricing')}).", "Pensado para el mercado español: interfaz, soporte y contenido en español."),
    ("Google Search Console", f"Sí ({src('pricing')}).", "Sí, en solo lectura y en todos los planes. Sus datos nunca se envían a modelos de IA."),
]

TABLE = "\n".join(
    f"          <tr><th scope=\"row\">{html.escape(t)}</th><td>{b}</td><td>{d}</td></tr>" for t, b, d in ROWS
)

DESC = f"BabyLoveGrowth frente a DNI Growth con datos públicos comprobados el {CHECKED}: precios, enlaces, imágenes con IA, revisión humana y CMS."
TITLE = "BabyLoveGrowth o DNI Growth: comparativa honesta"
assert len(DESC) <= 160 and len(TITLE + " · DNI Growth") <= 65, (len(DESC), len(TITLE))

FAQ = [
    ("¿Es mala idea una red de intercambio de enlaces?", "Las políticas de Google sobre spam incluyen los intercambios excesivos de enlaces. Que una red concreta perjudique o no a una web depende de cómo funcione y de cómo lo valore Google; nosotros preferimos no asumir ese riesgo en nombre de nuestros clientes."),
    ("¿Por qué marcáis las imágenes como creadas con IA?", "Por transparencia con quien las ve y porque la normativa europea de IA pide que el contenido sintético se pueda identificar. La marca no afecta a la calidad de la imagen."),
    ("¿Cuándo me conviene más BabyLoveGrowth?", "Si necesitas publicar hoy en Shopify, Webflow o Wix, escribir en muchos idiomas o seguir ChatGPT y Claude además de Gemini, hoy ofrece más en esos puntos."),
]

body = f"""      <p class="tool-crumbs"><a href="/">← Inicio</a></p>
      <h1>BabyLoveGrowth o DNI Growth: comparativa honesta</h1>
      <p class="lead-in">Las dos herramientas ayudan a conseguir tráfico desde Google y los asistentes de IA con contenido y SEO. Se diferencian sobre todo en cómo consiguen enlaces, en la transparencia con las imágenes creadas con IA y en dónde están la empresa y los datos.</p>
      <p class="tool-note">Datos de BabyLoveGrowth tomados de sus páginas públicas el {CHECKED}; cada fila enlaza a su fuente. Los precios y las funciones pueden cambiar: compruébalos en su web antes de decidir. Si ves un dato desactualizado, escríbenos a <a href="mailto:soporte@dnigrowth.com">soporte@dnigrowth.com</a> y lo corregimos.</p>
      <div class="tw">
        <table class="compare">
          <caption>Comparativa a {CHECKED}</caption>
          <thead><tr><th scope="col">Tema</th><th scope="col">BabyLoveGrowth</th><th scope="col">DNI Growth</th></tr></thead>
          <tbody>
{TABLE}
          </tbody>
        </table>
      </div>
      <h2>Dónde BabyLoveGrowth va por delante hoy</h2>
      <ul>
        <li>Publica directamente en más plataformas (Shopify, Webflow, Wix y otras).</li>
        <li>Escribe en más de 50 idiomas.</li>
        <li>Sigue ChatGPT, Claude y Gemini; nosotros, de momento, Gemini.</li>
      </ul>
      <h2>Dónde creemos que DNI Growth encaja mejor</h2>
      <ul>
        <li>Si prefieres no participar en redes de intercambio de enlaces.</li>
        <li>Si quieres que las imágenes creadas con IA se puedan identificar como tales.</li>
        <li>Si necesitas que nada se publique sin la aprobación de una persona, con historial de quién aprobó qué.</li>
        <li>Si buscas una empresa en España, en español y con planes desde 0 €.</li>
      </ul>
      <h2>Preguntas frecuentes</h2>
      <div class="tool-faq">
{chr(10).join(f"        <details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>" for q, a in FAQ)}
      </div>
      <p class="tool-note">BabyLoveGrowth es una marca de su titular. Esta página no está patrocinada ni revisada por BabyLoveGrowth.</p>
      <aside class="tool-cta">
        <h2>Compruébalo con tu propia web</h2>
        <p>La auditoría gratuita revisa hasta 5 páginas públicas en un par de minutos. Sin tarjeta y sin registro.</p>
        <p><a class="btn btn-accent" href="/#auditar">Auditar mi web gratis</a> <a class="btn" href="/precios">Ver planes</a></p>
      </aside>"""

ld = json.dumps(
    {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": "__SITE_URL__/comparativa/babylovegrowth#webpage",
                "url": "__SITE_URL__/comparativa/babylovegrowth",
                "name": TITLE,
                "description": DESC,
                "inLanguage": "es-ES",
                "dateModified": CHECKED_ISO,
                "isPartOf": {"@type": "WebSite", "@id": "__SITE_URL__/#website", "name": "DNI Growth", "url": "__SITE_URL__/"},
                "publisher": {"@type": "Organization", "@id": "__SITE_URL__/#organization", "name": "DNI Growth", "url": "__SITE_URL__/"},
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Inicio", "item": "__SITE_URL__/"},
                    {"@type": "ListItem", "position": 2, "name": TITLE, "item": "__SITE_URL__/comparativa/babylovegrowth"},
                ],
            },
            {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]},
        ],
    },
    ensure_ascii=False,
).replace("<", "\\u003c")

page = f"""<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{html.escape(TITLE)} · DNI Growth</title>
    <meta name="description" content="{html.escape(DESC)}" />
    <link rel="canonical" href="__SITE_URL__/comparativa/babylovegrowth" />
    <meta name="theme-color" content="#0b0b0c" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="/src/landing/landing.css" />
    <link rel="stylesheet" href="/src/landing/legal.css" />
    <link rel="stylesheet" href="/src/landing/tools.css" />
    <script type="application/ld+json">{ld}</script>
  </head>
  <body>
    <a class="skip" href="#main">Saltar al contenido</a>
    <header class="nav is-solid"><a class="brand" href="/" aria-label="DNI Growth, inicio"><span class="brand-mark" aria-hidden="true">DNI</span><span class="brand-word">Growth</span></a><a class="btn" href="/#auditar">Auditar mi web gratis</a></header>
    <main id="main" class="legal tools">
{body}
    </main>
    <nav class="legal-foot" aria-label="Más páginas">
      <a href="/">Inicio</a>
      <a href="/precios">Precios</a>
      <a href="/herramientas">Herramientas gratuitas</a>
      <a href="/seo-con-ia">SEO con IA</a>
      <a href="/geo-posicionar-en-chatgpt">Aparecer en ChatGPT</a>
      <a href="/legal/privacidad">Privacidad</a>
    </nav>
  </body>
</html>
"""
(ROOT / "comparativa" / "babylovegrowth.html").write_text(page, encoding="utf-8", newline="\n")
print("ok")
