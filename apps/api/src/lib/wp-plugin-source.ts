/**
 * Source of the «DNI Growth Connector» WordPress plugin, served as a zip from /descargas/dni-growth-connector.zip.
 * Kept as text here so the Worker can build the zip without a build step. Never put "${" or backticks in the PHP.
 * What it does (all through the authenticated WordPress REST API, with the user's own capabilities):
 *  - SEO title, meta description, canonical and JSON-LD per post/page (mirrored into Yoast SEO / Rank Math when active);
 *  - llms.txt served at the site root from an option;
 *  - reversible technical fixes (title, description, canonical, JSON-LD, image alt text, llms.txt) with before/after.
 */
export const WP_PLUGIN_VERSION = "1.0.0";
export const WP_PLUGIN_SLUG = "dni-growth-connector";

const MAIN = String.raw`<?php
/**
 * Plugin Name:       DNI Growth Connector
 * Plugin URI:        https://dnigrowth.com/seo-wordpress
 * Description:       Conecta tu WordPress con DNI Growth: título y descripción SEO (compatible con Yoast SEO y Rank Math), datos estructurados JSON-LD, llms.txt y correcciones técnicas reversibles que apruebas en DNI Growth.
 * Version:           ${WP_PLUGIN_VERSION}
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            DNI Growth
 * Author URI:        https://dnigrowth.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       dni-growth-connector
 */

if (!defined('ABSPATH')) {
	exit;
}

define('DNI_GROWTH_CONNECTOR_VERSION', '${WP_PLUGIN_VERSION}');
define('DNI_GROWTH_FIX_LOG_MAX', 50);

/** Our own post meta keys (protected: leading underscore; only users who can edit the post can change them). */
function dni_growth_meta_keys() {
	return array(
		'title'       => '_dni_seo_title',
		'description' => '_dni_seo_description',
		'canonical'   => '_dni_canonical',
		'jsonld'      => '_dni_jsonld',
	);
}

function dni_growth_seo_plugin() {
	if (defined('WPSEO_VERSION')) {
		return 'yoast';
	}
	if (defined('RANK_MATH_VERSION') || class_exists('RankMath')) {
		return 'rank-math';
	}
	return null;
}

/** JSON-LD must be a JSON object or array; anything else is dropped. Returns the canonical encoding or ''. */
function dni_growth_clean_jsonld($value) {
	if (!is_string($value) || trim($value) === '') {
		return '';
	}
	$decoded = json_decode($value, true);
	if (!is_array($decoded)) {
		return '';
	}
	return wp_json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function dni_growth_sanitize($field, $value) {
	switch ($field) {
		case 'title':
			return mb_substr(sanitize_text_field((string) $value), 0, 200);
		case 'description':
			return mb_substr(sanitize_textarea_field((string) $value), 0, 500);
		case 'canonical':
			$url = esc_url_raw((string) $value, array('https', 'http'));
			return $url ? $url : '';
		case 'jsonld':
			return dni_growth_clean_jsonld($value);
		case 'alt':
			return mb_substr(sanitize_text_field((string) $value), 0, 300);
	}
	return '';
}

add_action('init', function () {
	foreach (array('post', 'page') as $type) {
		foreach (dni_growth_meta_keys() as $field => $key) {
			register_post_meta($type, $key, array(
				'type'              => 'string',
				'single'            => true,
				'show_in_rest'      => true,
				'default'           => '',
				'sanitize_callback' => function ($value) use ($field) {
					return dni_growth_sanitize($field, $value);
				},
				'auth_callback'     => function ($allowed, $meta_key, $post_id) {
					return current_user_can('edit_post', $post_id);
				},
			));
		}
	}
});

/** Mirror our values into Yoast SEO / Rank Math so their output (title, description, canonical) uses them. */
function dni_growth_mirror($post_id, $field, $value) {
	$map = array(
		'yoast'     => array('title' => '_yoast_wpseo_title', 'description' => '_yoast_wpseo_metadesc', 'canonical' => '_yoast_wpseo_canonical'),
		'rank-math' => array('title' => 'rank_math_title', 'description' => 'rank_math_description', 'canonical' => 'rank_math_canonical_url'),
	);
	$plugin = dni_growth_seo_plugin();
	if (!$plugin || !isset($map[$plugin][$field])) {
		return;
	}
	if ($value === '') {
		delete_post_meta($post_id, $map[$plugin][$field]);
	} else {
		update_post_meta($post_id, $map[$plugin][$field], $value);
	}
}

$dni_growth_on_meta = function ($meta_id, $post_id, $meta_key, $meta_value) {
	$field = array_search($meta_key, dni_growth_meta_keys(), true);
	if ($field !== false) {
		dni_growth_mirror($post_id, $field, (string) $meta_value);
	}
};
add_action('added_post_meta', $dni_growth_on_meta, 10, 4);
add_action('updated_post_meta', $dni_growth_on_meta, 10, 4);
add_action('deleted_post_meta', function ($meta_ids, $post_id, $meta_key) {
	$field = array_search($meta_key, dni_growth_meta_keys(), true);
	if ($field !== false) {
		dni_growth_mirror($post_id, $field, '');
	}
}, 10, 3);

/* ── Front end ─────────────────────────────────────────────────────────────────────────────────── */

function dni_growth_current_meta($field) {
	if (!is_singular()) {
		return '';
	}
	$keys = dni_growth_meta_keys();
	return (string) get_post_meta(get_queried_object_id(), $keys[$field], true);
}

add_filter('pre_get_document_title', function ($title) {
	if (dni_growth_seo_plugin()) {
		return $title; // Yoast / Rank Math print the mirrored value.
	}
	$own = dni_growth_current_meta('title');
	return $own !== '' ? $own : $title;
}, 20);

add_action('wp', function () {
	if (!dni_growth_seo_plugin() && dni_growth_current_meta('canonical') !== '') {
		remove_action('wp_head', 'rel_canonical');
	}
});

add_action('wp_head', function () {
	if (!dni_growth_seo_plugin()) {
		$description = dni_growth_current_meta('description');
		if ($description !== '') {
			echo '<meta name="description" content="' . esc_attr($description) . '" />' . "\n";
		}
		$canonical = dni_growth_current_meta('canonical');
		if ($canonical !== '') {
			echo '<link rel="canonical" href="' . esc_url($canonical) . '" />' . "\n";
		}
	}
	$jsonld = dni_growth_current_meta('jsonld');
	if ($jsonld !== '') {
		$decoded = json_decode($jsonld, true);
		if (is_array($decoded)) {
			// JSON_HEX_TAG turns < and > into < / > so the content can never close the script tag.
			echo '<script type="application/ld+json">' . wp_json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP) . '</script>' . "\n";
		}
	}
}, 5);

/** llms.txt at the site root (only when no real file exists there: the web server serves a real file first). */
add_action('init', function () {
	$path = isset($_SERVER['REQUEST_URI']) ? wp_parse_url(wp_unslash($_SERVER['REQUEST_URI']), PHP_URL_PATH) : '';
	$home = wp_parse_url(home_url('/'), PHP_URL_PATH);
	if ($path !== rtrim((string) $home, '/') . '/llms.txt') {
		return;
	}
	$content = (string) get_option('dni_growth_llms_txt', '');
	if ($content === '') {
		return;
	}
	header('Content-Type: text/plain; charset=utf-8');
	header('X-Robots-Tag: noindex');
	echo $content; // Plain text, served as text/plain.
	exit;
}, 0);

/* ── REST API: status, reversible fixes and llms.txt ──────────────────────────────────────────────── */

function dni_growth_fix_log($post_id) {
	$log = get_post_meta($post_id, '_dni_fix_log', true);
	return is_array($log) ? $log : array();
}

function dni_growth_target($request) {
	$attachment_id = absint($request->get_param('attachment_id'));
	if ($attachment_id) {
		return get_post_type($attachment_id) === 'attachment' ? $attachment_id : 0;
	}
	$post_id = absint($request->get_param('post_id'));
	if (!$post_id && $request->get_param('url')) {
		$post_id = url_to_postid(esc_url_raw((string) $request->get_param('url')));
		if (!$post_id && untrailingslashit((string) $request->get_param('url')) === untrailingslashit(home_url('/'))) {
			$post_id = (int) get_option('page_on_front');
		}
	}
	return $post_id && in_array(get_post_type($post_id), array('post', 'page'), true) ? $post_id : 0;
}

function dni_growth_read($post_id, $field) {
	if ($field === 'alt') {
		return (string) get_post_meta($post_id, '_wp_attachment_image_alt', true);
	}
	$keys = dni_growth_meta_keys();
	return (string) get_post_meta($post_id, $keys[$field], true);
}

function dni_growth_write($post_id, $field, $value) {
	$key = $field === 'alt' ? '_wp_attachment_image_alt' : dni_growth_meta_keys()[$field];
	if ($value === '') {
		delete_post_meta($post_id, $key);
	} else {
		update_post_meta($post_id, $key, wp_slash($value));
	}
}

add_action('rest_api_init', function () {
	register_rest_route('dni-growth/v1', '/status', array(
		'methods'             => 'GET',
		'permission_callback' => function () {
			return current_user_can('edit_posts');
		},
		'callback'            => function () {
			return array(
				'plugin'     => 'dni-growth-connector',
				'version'    => DNI_GROWTH_CONNECTOR_VERSION,
				'seoPlugin'  => dni_growth_seo_plugin(),
				'llmsTxt'    => get_option('dni_growth_llms_txt', '') !== '',
				'canLlmsTxt' => current_user_can('manage_options'),
			);
		},
	));

	register_rest_route('dni-growth/v1', '/fix', array(
		'methods'             => 'POST',
		'permission_callback' => function ($request) {
			$id = dni_growth_target($request);
			return $id && current_user_can('edit_post', $id);
		},
		'args'                => array(
			'field' => array('required' => true, 'enum' => array('title', 'description', 'canonical', 'jsonld', 'alt')),
			'value' => array('required' => true, 'type' => 'string'),
			'ref'   => array('required' => false, 'type' => 'string'),
		),
		'callback'            => function ($request) {
			$id = dni_growth_target($request);
			$field = $request->get_param('field');
			if (($field === 'alt') !== (get_post_type($id) === 'attachment')) {
				return new WP_Error('dni_growth_bad_target', 'Ese campo no corresponde a ese tipo de contenido.', array('status' => 400));
			}
			$value = dni_growth_sanitize($field, $request->get_param('value'));
			if ($field === 'jsonld' && $value === '' && trim((string) $request->get_param('value')) !== '') {
				return new WP_Error('dni_growth_bad_jsonld', 'El JSON-LD no es un JSON válido.', array('status' => 400));
			}
			$ref = substr(preg_replace('/[^A-Za-z0-9_-]/', '', (string) $request->get_param('ref')), 0, 64);
			$log = dni_growth_fix_log($id);
			// Idempotent: the same ref (DNI Growth's fix id) applied twice returns the first result.
			foreach ($log as $entry) {
				if ($ref !== '' && isset($entry['ref']) && $entry['ref'] === $ref) {
					return array_merge($entry, array('postId' => $id, 'repeated' => true));
				}
			}
			$before = dni_growth_read($id, $field);
			dni_growth_write($id, $field, $value);
			$entry = array(
				'id'     => wp_generate_uuid4(),
				'ref'    => $ref,
				'field'  => $field,
				'before' => $before,
				'after'  => $value,
				'at'     => gmdate('c'),
				'user'   => get_current_user_id(),
			);
			$log[] = $entry;
			update_post_meta($id, '_dni_fix_log', array_slice($log, -DNI_GROWTH_FIX_LOG_MAX));
			return array_merge($entry, array('postId' => $id, 'url' => get_permalink($id)));
		},
	));

	register_rest_route('dni-growth/v1', '/fix/revert', array(
		'methods'             => 'POST',
		'permission_callback' => function ($request) {
			$id = absint($request->get_param('post_id'));
			return $id && current_user_can('edit_post', $id);
		},
		'args'                => array(
			'post_id' => array('required' => true, 'type' => 'integer'),
			'fix_id'  => array('required' => true, 'type' => 'string'),
		),
		'callback'            => function ($request) {
			$id = absint($request->get_param('post_id'));
			$log = dni_growth_fix_log($id);
			foreach ($log as $i => $entry) {
				if ($entry['id'] !== $request->get_param('fix_id')) {
					continue;
				}
				if (!empty($entry['reverted'])) {
					return array_merge($entry, array('postId' => $id, 'repeated' => true));
				}
				dni_growth_write($id, $entry['field'], (string) $entry['before']);
				$log[$i]['reverted'] = gmdate('c');
				update_post_meta($id, '_dni_fix_log', $log);
				return array_merge($log[$i], array('postId' => $id));
			}
			return new WP_Error('dni_growth_fix_not_found', 'No se encuentra esa corrección.', array('status' => 404));
		},
	));

	register_rest_route('dni-growth/v1', '/llms', array(
		'methods'             => 'POST',
		'permission_callback' => function () {
			return current_user_can('manage_options');
		},
		'args'                => array('content' => array('required' => true, 'type' => 'string')),
		'callback'            => function ($request) {
			$content = (string) $request->get_param('content');
			$content = mb_substr(wp_check_invalid_utf8(str_replace("\r\n", "\n", $content)), 0, 100000);
			$before = (string) get_option('dni_growth_llms_txt', '');
			update_option('dni_growth_llms_txt_previous', $before, false);
			update_option('dni_growth_llms_txt', $content, false);
			return array('field' => 'llms', 'before' => $before, 'after' => $content, 'url' => home_url('/llms.txt'));
		},
	));
});
`;

const UNINSTALL = String.raw`<?php
// Removes everything the plugin stored. Yoast SEO / Rank Math values it mirrored stay as they are.
if (!defined('WP_UNINSTALL_PLUGIN')) {
	exit;
}
delete_option('dni_growth_llms_txt');
delete_option('dni_growth_llms_txt_previous');
foreach (array('_dni_seo_title', '_dni_seo_description', '_dni_canonical', '_dni_jsonld', '_dni_fix_log') as $key) {
	delete_post_meta_by_key($key);
}
`;

const README = `=== DNI Growth Connector ===
Contributors: dnigrowth
Tags: seo, json-ld, llms.txt, yoast, rank math
Requires at least: 6.0
Tested up to: 6.9
Requires PHP: 7.4
Stable tag: ${WP_PLUGIN_VERSION}
License: GPLv2 or later

Conecta tu WordPress con DNI Growth.

== Description ==

* Título y descripción SEO, canonical y datos estructurados JSON-LD por entrada y página. Si usas Yoast SEO o Rank Math, los valores se copian en sus campos y ellos los muestran.
* llms.txt en la raíz de tu web, gestionado desde DNI Growth.
* Correcciones técnicas que apruebas en DNI Growth (título, descripción, canonical, JSON-LD, texto alternativo de imágenes, llms.txt). Cada una guarda el valor anterior y se puede deshacer.

El plugin no se conecta a ningún servidor externo. DNI Growth le envía los cambios a través de la API REST de WordPress con la contraseña de aplicación que tú creas, y solo puede hacer lo que permite el rol de ese usuario.

== Installation ==

1. Plugins → Añadir nuevo → Subir plugin → elige el zip → Instalar → Activar.
2. En DNI Growth, conecta tu WordPress (Contenidos → WordPress) con una contraseña de aplicación de un usuario Editor o Administrador (Administrador para gestionar llms.txt).

== Uninstall ==

Al borrar el plugin se eliminan sus datos. Los valores copiados en Yoast SEO o Rank Math se mantienen.
`;

export const WP_PLUGIN_FILES: Record<string, string> = {
  [`${WP_PLUGIN_SLUG}/${WP_PLUGIN_SLUG}.php`]: MAIN,
  [`${WP_PLUGIN_SLUG}/uninstall.php`]: UNINSTALL,
  [`${WP_PLUGIN_SLUG}/readme.txt`]: README,
};
