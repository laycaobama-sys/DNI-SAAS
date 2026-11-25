"""Generates the product and sector landing pages from one template.

Run from apps/web:  python scripts/landings.py
Edit the texts here and re-run; the generated HTML files are committed. Every claim must match what the
product does today (packages/core/src/features.ts and pricing.ts): "Parcial" and "en desarrollo" are said
out loud, and nothing promises rankings, citations or revenue.
"""
import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
(ROOT / "sectores").mkdir(exist_ok=True)

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
    <script type="application/ld+json">{ld}</script>
  </head>
  <body>
    <a class="skip" href="#main">Saltar al contenido</a>
    <header class="nav is-solid"><a class="brand" href="/" aria-label="DNI Growth, inicio"><span class="brand-mark" aria-hidden="true">DNI</span><span class="brand-word">Growth</span></a><a class="btn" href="/#auditar">Auditar mi web gratis</a></header>
    <main id="main" class="legal tools landing-page" data-landing="{slug}">
{body}
    </main>
    <nav class="legal-foot" aria-label="Más páginas">
{footer}
    </nav>
  </body>
</html>
"""

PRODUCT = [
    ("/seo-con-ia", "SEO con IA"),
    ("/geo-posicionar-en-chatgpt", "Aparecer en ChatGPT (GEO)"),
    ("/auditoria-seo-gratis", "Auditoría SEO gratis"),
    ("/seo-wordpress", "SEO para WordPress"),
    ("/seo-shopify", "SEO para Shopify"),
    ("/para-agencias", "Para agencias"),
]
SECTORS = [
    ("/sectores/clinicas", "Clínicas"),
    ("/sectores/despachos", "Despachos profesionales"),
    ("/sectores/ecommerce", "Tiendas online"),
    ("/sectores/restaurantes", "Restaurantes"),
    ("/sectores/inmobiliarias", "Inmobiliarias"),
    ("/sectores/reformas", "Empresas de reformas"),
]

CTA = """      <aside class="tool-cta">
        <h2>Empieza por ver cómo está tu web</h2>
        <p>La auditoría gratuita revisa hasta 5 páginas públicas de tu web en un par de minutos: SEO técnico, metadatos, datos estructurados y si los buscadores con IA pueden leerla. Sin tarjeta y sin registro.</p>
        <p><a class="btn btn-accent" href="/#auditar">Auditar mi web gratis</a> <a class="btn" href="/precios">Ver planes y precios</a></p>
      </aside>"""

HONEST = """      <p class="tool-note">Nadie puede garantizar una posición en Google ni que un asistente de IA te mencione. Lo que sí hacemos: enseñarte con pruebas qué falla, ayudarte a arreglarlo y medir el resultado con tus propios datos.</p>"""

PAGES = [
    # ── Producto ──────────────────────────────────────────────────────────────────────────────────
    {
        "path": "/seo-con-ia",
        "title": "SEO con IA para pymes, con pruebas · DNI Growth",
        "desc": "SEO con IA que enseña la página exacta de cada problema, ordena qué arreglar primero y redacta borradores que revisa una persona. Prueba la auditoría gratis.",
        "h1": "SEO con IA, pero con pruebas",
        "lead": "DNI Growth revisa tu web como la ven Google y los asistentes con IA, te dice qué arreglar primero y te ayuda a hacerlo. Cada recomendación enseña la página y el dato en el que se basa.",
        "sections": [
            ("Qué hace por ti", """<ul>
        <li><strong>Auditoría técnica con evidencia:</strong> rastrea tus páginas públicas (respetando robots.txt) y enseña cada problema con la URL exacta: títulos, descripciones, enlaces rotos, redirecciones, datos estructurados, imágenes y más.</li>
        <li><strong>Prioridades claras:</strong> ordena los problemas por impacto y esfuerzo, y prepara un plan de 30 días que puedes editar.</li>
        <li><strong>Contenido con revisión humana:</strong> Content Studio redacta borradores con IA a partir de un brief; nada se publica sin que una persona de tu equipo lo apruebe.</li>
        <li><strong>Tus datos reales:</strong> conecta Google Search Console y Google Analytics 4 en solo lectura para ver clics e impresiones con fuente y fecha. Esos datos no se envían a ningún modelo de IA.</li>
        <li><strong>Publicación en WordPress:</strong> lo aprobado se publica en tu web desde el plan Starter.</li>
      </ul>"""),
            ("Qué hace la IA y qué no", """<p>La IA ayuda a redactar, resumir y proponer. No decide sola: los cambios que salen de tu cuenta (publicar, enviar, gastar) siempre piden la aprobación de una persona con permiso. Y no inventamos cifras: cada métrica dice de dónde sale, cuándo se midió y si es observada, calculada o estimada.</p>"""),
            ("Para quién es", """<p>Para pymes, profesionales y equipos de marketing pequeños que quieren hacer SEO en serio sin contratar una agencia para todo, y para agencias que quieren trabajar con varias webs y clientes en una sola cuenta.</p>"""),
        ],
        "faq": [
            ("¿El contenido escrito con IA perjudica en Google?", "Google valora que el contenido sea útil y fiable, no cómo se escribió. Por eso cada borrador pasa por revisión humana y por comprobaciones que avisan de promesas, cifras sin fuente y datos sin verificar."),
            ("¿Cuánto cuesta?", "Hay un plan Free para empezar. Los planes de pago van de Starter (49 € al mes sin IVA) a Agency. Todos los precios y lo que incluye cada plan están en /precios."),
        ],
    },
    {
        "path": "/geo-posicionar-en-chatgpt",
        "title": "GEO: cómo aparecer en ChatGPT y otros asistentes · DNI Growth",
        "desc": "Prepara tu web para que ChatGPT, Perplexity, Gemini y Claude la entiendan y la citen, y mide por muestreo si te mencionan. Sin promesas imposibles.",
        "h1": "Cómo aparecer en ChatGPT y otros asistentes de IA",
        "lead": "Cada vez más gente pregunta a un asistente en lugar de buscar en Google. El GEO (Generative Engine Optimization) consiste en que esos asistentes puedan leer tu web, entender qué haces y recomendarte cuando encaja.",
        "sections": [
            ("Lo que depende de tu web", """<ol>
        <li><strong>Que te puedan leer:</strong> tu robots.txt no debe bloquear a los robots de búsqueda de ChatGPT (OAI-SearchBot), Claude, Perplexity, Bing o Google. Bloquear los de entrenamiento es otra decisión distinta.</li>
        <li><strong>Que el texto esté en el HTML:</strong> muchos robots de IA no ejecutan JavaScript. Si tu web se pinta solo con JavaScript, pueden ver una página vacía.</li>
        <li><strong>Que se entienda quién eres:</strong> datos estructurados (Organization o LocalBusiness), nombre, dirección y servicios coherentes en toda la web y en tus perfiles.</li>
        <li><strong>Que respondas preguntas concretas:</strong> los asistentes citan mejor respuestas claras, con datos y fuente, que textos genéricos.</li>
      </ol>
      <p>Puedes comprobar tu web gratis con la herramienta <a href="/herramientas/preparada-para-ia">¿Tu web está preparada para ChatGPT?</a></p>"""),
            ("Cómo lo mide DNI Growth", """<p>El monitor de visibilidad en IA hace periódicamente las preguntas que eliges (por ejemplo, «mejor clínica dental en Lavapiés») y guarda si te mencionan, a quién citan y con qué fuentes. Hoy pregunta a Gemini; ChatGPT, Claude y Perplexity se añadirán cuando estén conectados.</p>
      <p>Es un <strong>muestreo</strong>: una foto de esas preguntas en ese momento, no una medida de todas las conversaciones reales. Las respuestas cambian con el tiempo y con cada persona.</p>"""),
            ("Lo que no hacemos", """<p>No vendemos «posicionar en ChatGPT» garantizado: nadie puede. Tampoco creamos redes de páginas o reseñas falsas para engañar a los modelos. Trabajamos lo que sí funciona a largo plazo: una web clara, útil y fácil de leer, y una marca coherente en internet.</p>"""),
        ],
        "faq": [
            ("¿El GEO sustituye al SEO?", "No. Los asistentes con búsqueda se apoyan en buscadores (Bing, Google y otros) para encontrar páginas. Una web con buen SEO técnico y buen contenido tiene la mayor parte del trabajo hecho."),
            ("¿Necesito un archivo llms.txt?", "Es opcional y ningún buscador ha confirmado que lo use para posicionar. Puede ayudar a que una IA encuentre tus páginas clave. Puedes crearlo gratis con nuestro generador."),
        ],
    },
    {
        "path": "/auditoria-seo-gratis",
        "title": "Auditoría SEO gratis de tu web en 2 minutos · DNI Growth",
        "desc": "Auditoría SEO gratuita y sin registro: revisa hasta 5 páginas públicas, puntúa SEO técnico, metadatos y preparación para IA, y enseña cada problema con su URL.",
        "h1": "Auditoría SEO gratis, sin registro",
        "lead": "Escribe la dirección de tu web y en un par de minutos tendrás una nota de 0 a 100 en técnica, SEO, contenido y preparación para buscadores con IA, con los tres problemas más importantes y la página exacta donde están.",
        "sections": [
            ("Qué revisa", """<ul>
        <li>Respuesta de las páginas, redirecciones, https y enlaces rotos.</li>
        <li>Títulos, descripciones, encabezados, canonical e indexación.</li>
        <li>Datos estructurados (JSON-LD), Open Graph e imágenes.</li>
        <li>robots.txt, sitemap.xml y si los robots de búsqueda con IA pueden leer tu web.</li>
      </ul>
      <p>Lee solo páginas públicas, como un visitante, y respeta tu robots.txt. No necesita acceso a tu web ni a tus cuentas.</p>"""),
            ("Qué recibes", """<p>Una página con tu resultado que puedes compartir, la comparación con un competidor si quieres y los tres problemas prioritarios con su evidencia. Si creas una cuenta gratis, ves la lista completa, el plan de 30 días y los borradores de corrección.</p>"""),
            ("Límites honestos", """<p>La versión gratuita revisa hasta 5 páginas: sirve para detectar lo importante, no para auditar una web de miles de URL. Los planes de pago rastrean entre 100 y 500 páginas por auditoría.</p>"""),
        ],
        "faq": [
            ("¿De verdad es gratis?", "Sí. No pedimos tarjeta ni registro. Hay un límite de auditorías por persona y por día para que el servicio siga siendo gratuito."),
            ("¿Guardáis mis datos?", "Guardamos el resultado de la auditoría para enseñarte la página de resultados y lo borramos a los 30 días si no lo asocias a una cuenta. Los detalles están en la política de privacidad."),
        ],
    },
    {
        "path": "/seo-wordpress",
        "title": "SEO para WordPress con publicación directa · DNI Growth",
        "desc": "Audita tu WordPress, prepara contenidos con revisión humana y publícalos en tu web con una contraseña de aplicación, sin plugins y sin duplicados.",
        "h1": "SEO para WordPress, de la auditoría a la publicación",
        "lead": "DNI Growth audita tu WordPress, te ayuda a preparar contenido útil y, cuando lo apruebas, lo publica directamente en tu web.",
        "sections": [
            ("Cómo se conecta", """<ol>
        <li>En tu WordPress: <strong>Usuarios → Perfil → Contraseñas de aplicación</strong>. Crea una llamada «DNI Growth».</li>
        <li>En DNI Growth, escribe la dirección de tu web, tu usuario y esa contraseña. No pedimos nunca tu contraseña de acceso.</li>
        <li>Desde cada contenido aprobado: <strong>Publicar ahora</strong>, <strong>Enviar como borrador</strong> o <strong>Retirar</strong> (vuelve a borrador; nunca borramos entradas).</li>
      </ol>
      <p>Requisitos: web con https, un usuario con rol Editor o Administrador, la API REST de WordPress activa y plan Starter o superior. La contraseña se guarda cifrada y, al desconectar, se revoca en tu WordPress.</p>"""),
            ("Problemas típicos de WordPress que detecta la auditoría", """<ul>
        <li>Páginas de etiquetas, autores y adjuntos indexadas sin valor, que compiten con tus páginas buenas.</li>
        <li>Títulos duplicados por plantillas del tema o por un plugin de SEO mal configurado.</li>
        <li>Imágenes enormes sin dimensiones ni texto alternativo.</li>
        <li>Enlaces internos rotos tras cambiar los enlaces permanentes.</li>
        <li>robots.txt o un plugin de seguridad que bloquea a los buscadores con IA sin que lo sepas.</li>
      </ul>"""),
            ("En desarrollo", """<p>Un plugin propio para gestionar también los metadatos de Yoast o Rank Math, la imagen destacada y las categorías. Hoy se publica el título, el contenido y el extracto.</p>"""),
        ],
        "faq": [
            ("¿Puede publicar algo sin que yo lo vea?", "No. Solo se publica contenido aprobado por una persona de tu equipo con permiso de aprobar, y cada publicación queda registrada con quién la aprobó."),
            ("¿Y si pulso dos veces o falla la conexión?", "No se duplica: cada contenido tiene una sola entrada en tu WordPress y los reintentos la actualizan en lugar de crear otra."),
        ],
    },
    {
        "path": "/seo-shopify",
        "title": "SEO para tiendas Shopify: auditoría y contenidos · DNI Growth",
        "desc": "Audita tu tienda Shopify: URLs duplicadas, colecciones sin texto, fichas sin datos estructurados e imágenes pesadas. Contenidos con revisión humana.",
        "h1": "SEO para tiendas Shopify",
        "lead": "Shopify resuelve mucho de serie, pero hay problemas que se repiten en casi todas las tiendas. DNI Growth los encuentra y te ayuda a priorizarlos.",
        "sections": [
            ("Lo que suele fallar en Shopify", """<ul>
        <li><strong>URLs duplicadas de producto:</strong> el mismo producto aparece en <code>/products/…</code> y en <code>/collections/…/products/…</code>. El canonical lo suele resolver, pero los enlaces internos deberían apuntar a la versión principal.</li>
        <li><strong>Colecciones sin texto:</strong> páginas de categoría con solo una rejilla de productos, que compiten mal en búsquedas genéricas.</li>
        <li><strong>Fichas sin datos completos:</strong> falta precio, disponibilidad, marca o reseñas en el marcado Product, o descripciones copiadas del fabricante.</li>
        <li><strong>Imágenes pesadas y sin texto alternativo</strong>, que frenan la carga en móvil.</li>
        <li><strong>Aplicaciones que añaden scripts</strong> y empeoran la velocidad.</li>
      </ul>"""),
            ("Qué puedes hacer hoy con DNI Growth", """<p>Auditar la tienda (sus páginas públicas), ver cada problema con su URL, conectar Search Console en solo lectura y preparar textos de colecciones y artículos del blog con revisión humana. Los textos se exportan en HTML o Markdown para pegarlos en Shopify.</p>
      <p><strong>En desarrollo:</strong> la publicación directa en Shopify. Hasta que esté lista, no la vendemos como disponible.</p>"""),
        ],
        "faq": [
            ("¿Necesitáis acceso a mi tienda?", "Para auditar, no: leemos las páginas públicas como un visitante. El acceso solo hará falta para publicar directamente, cuando esa función esté lista."),
            ("¿Sirve para otras plataformas?", "Sí. La auditoría funciona con cualquier web pública: WooCommerce, PrestaShop, Wix, Squarespace o una web hecha a medida."),
        ],
    },
    {
        "path": "/para-agencias",
        "title": "Herramienta de SEO y GEO para agencias · DNI Growth",
        "desc": "Gestiona varias webs y clientes en una cuenta, con datos separados, permisos por persona, aprobación del cliente e informes. Plan Agency con 15 webs.",
        "h1": "SEO y GEO para agencias",
        "lead": "Trabaja con todos tus clientes en una sola cuenta: auditorías con evidencia, contenidos con aprobación, datos de Search Console y un historial de quién hizo qué.",
        "sections": [
            ("Pensado para trabajar con clientes", """<ul>
        <li><strong>Datos separados por cliente:</strong> cada cliente es una organización propia; lo de uno nunca se ve desde otro.</li>
        <li><strong>Permisos por persona:</strong> propietario, administración, marketing, edición, análisis y cliente con acceso de lectura, entre otros.</li>
        <li><strong>Aprobación antes de publicar:</strong> el cliente o tu responsable aprueba; todo queda en el historial.</li>
        <li><strong>Informes con fuente:</strong> cada cifra dice de dónde sale y cuándo se midió. Se exportan desde Informes.</li>
      </ul>"""),
            ("Plan Agency", """<p>15 webs, usuarios ilimitados, 600 auditorías al mes y organizaciones de cliente con tu marca. Precio y detalle en <a href="/precios">/precios</a>.</p>
      <p><strong>Parcial hoy:</strong> el portal con tu marca usa nuestro dominio (el dominio propio está en desarrollo) y el informe mensual se exporta, pero el envío automático por email está en desarrollo.</p>"""),
            ("Cómo trabajamos", """<p>Sin redes de intercambio de enlaces ni contenido masivo de baja calidad: tus clientes no pagan el riesgo. Cada recomendación tiene evidencia que puedes enseñar en una reunión.</p>"""),
        ],
        "faq": [
            ("¿Puedo dar acceso a mi cliente?", "Sí, con el rol de cliente: ve los informes y el trabajo de su organización, sin poder cambiar la configuración."),
            ("¿Hay acuerdo de encargo del tratamiento?", "Sí, hay un borrador publicado en /legal/encargo-tratamiento y la lista de proveedores en /subencargados."),
        ],
    },
    # ── Sectores ──────────────────────────────────────────────────────────────────────────────────
    {
        "path": "/sectores/clinicas",
        "title": "SEO para clínicas: dentales, fisioterapia y estética · DNI Growth",
        "desc": "SEO y GEO para clínicas: ficha de Google, páginas por tratamiento, datos estructurados, reseñas y contenido de salud fiable. Auditoría gratis de tu web.",
        "h1": "SEO para clínicas",
        "lead": "Cuando alguien busca «dentista cerca de mí» o pregunta a un asistente qué clínica le recomiendan, compiten tu web, tu ficha de Google y tus reseñas. Esto es lo que más pesa.",
        "sections": [
            ("Lo básico que más se nota", """<ul>
        <li><strong>Una página por tratamiento</strong> (implantes, ortodoncia invisible, fisioterapia deportiva…) que explique en qué consiste, para quién es, cuánto dura y qué pasa después. Una lista de servicios en una sola página compite peor.</li>
        <li><strong>Nombre, dirección y teléfono idénticos</strong> en la web, en tu ficha de Google y en los directorios.</li>
        <li><strong>Datos estructurados</strong> de tipo MedicalClinic o Dentist con horario, dirección y teléfono.</li>
        <li><strong>Quién hay detrás:</strong> profesionales con nombre, titulación y número de colegiación. En salud, Google y los asistentes dan mucho peso a la experiencia y la fiabilidad.</li>
      </ul>"""),
            ("Contenido de salud que ayuda (y que no)", """<p>Responde dudas reales de tus pacientes («¿duele un implante?», «¿cuántas sesiones necesito?») con información prudente y revisada por un profesional. Evita prometer resultados: la publicidad sanitaria tiene normas propias en España y tu colegio profesional puede orientarte.</p>
      <p>DNI Growth avisa en cada borrador de promesas de resultados y cifras sin fuente antes de aprobarlo.</p>"""),
            ("Reseñas", """<p>Pide reseñas después de cada visita, respóndelas todas y nunca las compres ni las inventes. Además de estar prohibido, las reseñas falsas pueden hacer que Google retire tu ficha.</p>"""),
        ],
        "faq": [
            ("¿Es mejor la ficha de Google o la web?", "Las dos se apoyan: la ficha aparece en el mapa y la web convence y resuelve dudas. Una ficha que enlaza a una página del tratamiento concreto suele convertir mejor que una que enlaza a la portada."),
        ],
    },
    {
        "path": "/sectores/despachos",
        "title": "SEO para despachos de abogados y asesorías · DNI Growth",
        "desc": "SEO para despachos y asesorías: páginas por especialidad y ciudad, respuestas claras a dudas legales y fiscales, y datos estructurados. Auditoría gratis.",
        "h1": "SEO para despachos profesionales",
        "lead": "Abogados, asesorías y gestorías compiten por búsquedas muy concretas («abogado de herencias en Valencia», «cómo darse de alta como autónomo»). Ganan las webs que responden mejor.",
        "sections": [
            ("Qué funciona", """<ul>
        <li><strong>Una página por especialidad</strong> con casos típicos, cómo trabajáis, plazos orientativos y qué documentos hacen falta.</li>
        <li><strong>Páginas de ciudad solo donde atendéis de verdad</strong>, con contenido propio. Copiar la misma página cambiando el nombre de la ciudad perjudica.</li>
        <li><strong>Respuestas a preguntas frecuentes</strong> escritas por el profesional, con la fecha de revisión y la norma en la que se basan. Los asistentes de IA citan respuestas claras y actualizadas.</li>
        <li><strong>Datos estructurados</strong> LegalService o AccountingService, con dirección y horario.</li>
      </ul>"""),
            ("Cuidado con", """<p>Las normas deontológicas de cada colegio sobre publicidad, la confidencialidad (nunca casos reconocibles sin permiso) y los textos que se quedan antiguos cuando cambia una ley. Revisa los artículos al menos una vez al año.</p>"""),
            ("Cómo ayuda DNI Growth", """<p>La auditoría encuentra páginas duplicadas, títulos genéricos y problemas técnicos; Content Studio prepara borradores que el profesional revisa y aprueba; el monitor de visibilidad en IA comprueba por muestreo si un asistente os menciona para vuestras preguntas clave.</p>"""),
        ],
        "faq": [
            ("¿Merece la pena el blog en un despacho?", "Sí, si responde dudas que tus clientes tienen antes de contratar y lo firma alguien del despacho. Diez artículos útiles y actualizados valen más que cien genéricos."),
        ],
    },
    {
        "path": "/sectores/ecommerce",
        "title": "SEO para tiendas online y e-commerce · DNI Growth",
        "desc": "SEO para tiendas online: categorías con contenido, fichas con datos estructurados, filtros sin duplicados y productos agotados. Auditoría gratis.",
        "h1": "SEO para tiendas online",
        "lead": "En una tienda online, la mayor parte del tráfico orgánico llega a categorías y fichas de producto. Estos son los problemas que más ventas cuestan.",
        "sections": [
            ("Los problemas más comunes", """<ul>
        <li><strong>Filtros que crean miles de URL</strong> (color, talla, precio) indexables y casi iguales. Decide qué combinaciones merecen página propia y bloquea o canonicaliza el resto.</li>
        <li><strong>Productos agotados que devuelven error</strong>. Si vuelve, mantén la ficha; si no, redirige al producto o categoría más parecido.</li>
        <li><strong>Descripciones del fabricante copiadas</strong>, iguales en cientos de tiendas.</li>
        <li><strong>Fichas sin marcado Product completo</strong> (precio, disponibilidad, marca, valoraciones): sin él no hay resultados enriquecidos.</li>
        <li><strong>Categorías sin texto útil</strong> ni enlaces a subcategorías.</li>
      </ul>"""),
            ("Cómo lo trabaja DNI Growth", """<p>Audita hasta 500 páginas por rastreo según el plan, con cada problema y su URL; conecta Search Console en solo lectura para ver qué categorías y productos reciben impresiones; y prepara textos de categoría y guías de compra con revisión humana.</p>
      <p>Publicación directa: WordPress (WooCommerce) disponible desde Starter; Shopify en desarrollo.</p>"""),
        ],
        "faq": [
            ("¿Cuántas páginas debería auditar?", "Empieza por las plantillas: una muestra de categorías, fichas y páginas de filtros. Un problema en la plantilla se repite en todas las páginas que la usan."),
        ],
    },
    {
        "path": "/sectores/restaurantes",
        "title": "SEO para restaurantes: Google y asistentes de IA · DNI Growth",
        "desc": "SEO para restaurantes: carta en HTML y no en PDF, ficha de Google completa, reservas, datos estructurados Restaurant y reseñas. Auditoría gratis de tu web.",
        "h1": "SEO para restaurantes",
        "lead": "«Dónde comer cerca», «restaurante vegano en Malasaña», «menú del día abierto ahora». Para salir ahí, tu web y tu ficha de Google tienen que decir lo mismo, claro y actualizado.",
        "sections": [
            ("Lo que más ayuda", """<ul>
        <li><strong>La carta en texto, no solo en PDF o en foto.</strong> Google y los asistentes de IA leen mejor el texto, y tus clientes también desde el móvil.</li>
        <li><strong>Ficha de Google completa:</strong> horario (también festivos), fotos reales, carta, enlace de reservas y categoría correcta.</li>
        <li><strong>Datos estructurados Restaurant</strong> con tipo de cocina, rango de precios, horario y enlace a la carta.</li>
        <li><strong>Una página por cada cosa que la gente busca:</strong> menú del día, grupos y eventos, opciones sin gluten o veganas, si las tienes.</li>
      </ul>"""),
            ("Reseñas y redes", """<p>Responde a las reseñas, también a las malas, con calma. Publicar fotos reales de platos y del local en Instagram y Facebook ayuda a que te elijan; DNI Growth permite preparar y aprobar esas publicaciones (función parcial mientras Meta aprueba la app para todos los clientes).</p>"""),
        ],
        "faq": [
            ("¿Necesito web si ya tengo ficha de Google?", "La ficha es lo más importante para búsquedas cercanas, pero la web da contexto a Google y a los asistentes, y es tuya: no depende de una plataforma de reservas o de reparto."),
        ],
    },
    {
        "path": "/sectores/inmobiliarias",
        "title": "SEO para inmobiliarias y agencias de alquiler · DNI Growth",
        "desc": "SEO para inmobiliarias: páginas de zona con información real, anuncios caducados sin errores y duplicados con los portales. Auditoría gratis.",
        "h1": "SEO para inmobiliarias",
        "lead": "Los portales dominan las búsquedas de pisos. Donde una inmobiliaria local puede ganar es en las búsquedas de zona y de servicio: «vender piso en Chamberí», «tasación en Getafe».",
        "sections": [
            ("Dónde puedes ganar a los portales", """<ul>
        <li><strong>Páginas de barrio o municipio</strong> con información que solo conoce alguien de la zona: precios orientativos con su fuente y fecha, colegios, transporte, qué tipo de vivienda se vende.</li>
        <li><strong>Páginas de servicio</strong> para propietarios: vender, alquilar, tasar, gestionar el alquiler.</li>
        <li><strong>Pruebas de experiencia:</strong> operaciones cerradas en la zona (sin datos personales) y equipo con nombre.</li>
      </ul>"""),
            ("Problemas técnicos típicos", """<ul>
        <li>Anuncios vendidos que devuelven error 404 o se quedan publicados meses.</li>
        <li>La misma descripción en tu web y en cinco portales.</li>
        <li>Buscadores internos que generan miles de páginas casi vacías indexadas.</li>
      </ul>
      <p>La auditoría de DNI Growth los detecta con la URL de cada caso.</p>"""),
        ],
        "faq": [
            ("¿Qué hago con los pisos vendidos?", "Si tienen enlaces o visitas, mantén la página marcada como vendida con enlaces a inmuebles parecidos de la zona; si no aportan nada, redirige a la página de la zona."),
        ],
    },
    {
        "path": "/sectores/reformas",
        "title": "SEO para empresas de reformas e instaladores · DNI Growth",
        "desc": "SEO para empresas de reformas: proyectos reales con fotos, páginas por servicio y zona sin copiar, presupuestos y reseñas. Auditoría gratis de tu web.",
        "h1": "SEO para empresas de reformas",
        "lead": "Quien busca «reforma de cocina en Alcalá» quiere ver trabajos reales, precios orientativos y saber que llegas a su zona. Tu web tiene que enseñarlo.",
        "sections": [
            ("Lo que convence a Google y a tus clientes", """<ul>
        <li><strong>Proyectos reales:</strong> una página por obra con fotos del antes y el después, qué se hizo, cuánto duró y la zona. Es tu mejor prueba de experiencia.</li>
        <li><strong>Una página por servicio</strong> (cocinas, baños, integrales, aislamiento) con qué incluye, plazos y rangos de precio orientativos con fecha.</li>
        <li><strong>Zonas de trabajo con contenido propio.</strong> Crear cien páginas iguales cambiando el nombre del pueblo perjudica: mejor pocas páginas con proyectos reales de cada zona.</li>
        <li><strong>Formulario de presupuesto sencillo</strong> y teléfono visible en el móvil.</li>
      </ul>"""),
            ("Cómo ayuda DNI Growth", """<p>Auditoría con evidencia, borradores de páginas de servicio y de proyectos con revisión humana, publicación en WordPress, landing pages con formularios antispam y un CRM para que ningún presupuesto se quede sin respuesta.</p>"""),
        ],
        "faq": [
            ("¿Pongo precios en la web?", "Los rangos orientativos con la fecha y lo que incluyen ayudan a filtrar contactos y responden la pregunta que más se hace. Explica de qué depende el precio final."),
        ],
    },
]


def footer(current):
    links = [("/", "Inicio")] + PRODUCT + SECTORS + [("/herramientas", "Herramientas gratuitas"), ("/precios", "Precios"), ("/blog", "Blog"), ("/legal/privacidad", "Privacidad")]
    return "\n".join(f'      <a href="{p}"{" aria-current=\"page\"" if p == current else ""}>{html.escape(n)}</a>' for p, n in links)


def ld(p, faq):
    crumbs = [{"@type": "ListItem", "position": 1, "name": "Inicio", "item": "__SITE_URL__/"}]
    if p["path"].startswith("/sectores/"):
        crumbs.append({"@type": "ListItem", "position": 2, "name": "Sectores", "item": "__SITE_URL__/sectores/clinicas"})
    crumbs.append({"@type": "ListItem", "position": len(crumbs) + 1, "name": p["h1"], "item": f"__SITE_URL__{p['path']}"})
    graph = [
        {
            "@type": "WebPage",
            "@id": f"__SITE_URL__{p['path']}#webpage",
            "url": f"__SITE_URL__{p['path']}",
            "name": p["h1"],
            "description": p["desc"],
            "inLanguage": "es-ES",
            "isPartOf": {"@type": "WebSite", "@id": "__SITE_URL__/#website", "name": "DNI Growth", "url": "__SITE_URL__/"},
            "publisher": {"@type": "Organization", "@id": "__SITE_URL__/#organization", "name": "DNI Growth", "url": "__SITE_URL__/"},
        },
        {"@type": "BreadcrumbList", "itemListElement": crumbs},
    ]
    if faq:
        graph.append({"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]})
    return json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace("<", "\\u003c")


for p in PAGES:
    assert len(p["title"]) <= 65, p["path"]
    assert len(p["desc"]) <= 160, p["path"]
    sections = "\n".join(f"      <h2>{html.escape(h)}</h2>\n      {content}" for h, content in p["sections"])
    faq_html = "\n".join(f"        <details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>" for q, a in p["faq"])
    body = f"""      <h1>{html.escape(p['h1'])}</h1>
      <p class="lead-in">{html.escape(p['lead'])}</p>
      <p><a class="btn btn-accent" href="/#auditar">Auditar mi web gratis</a></p>
{sections}
      <h2>Preguntas frecuentes</h2>
      <div class="tool-faq">
{faq_html}
      </div>
{HONEST}
{CTA}"""
    out = HEAD.format(title=html.escape(p["title"]), desc=html.escape(p["desc"]), path=p["path"], ld=ld(p, p["faq"]), slug=p["path"].strip("/"), body=body, footer=footer(p["path"]))
    (ROOT / f"{p['path'].strip('/')}.html").write_text(out, encoding="utf-8", newline="\n")

print("ok", len(PAGES))
