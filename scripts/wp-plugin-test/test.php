<?php
// Real WordPress test of the «DNI Growth Connector» plugin, run by scripts/wp-plugin-test.mjs in WordPress Playground.
// Writes results to /wordpress/wpout/result.txt. ($pg_id, not $page: $page is a WordPress global.)
require_once '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$out = array();
$fail = 0;
function check($name, $cond, $extra = '') {
	global $out, $fail;
	if (!$cond) { $fail++; }
	$out[] = ($cond ? 'PASS ' : 'FAIL ') . $name . ($extra !== '' ? ' :: ' . $extra : '');
}
function req($method, $route, $params = array()) {
	$r = new WP_REST_Request($method, $route);
	if ($method === 'GET') { foreach ($params as $k => $v) { $r->set_param($k, $v); } }
	else { $r->set_header('content-type', 'application/json'); $r->set_body(wp_json_encode($params)); }
	$res = rest_do_request($r);
	return array($res->get_status(), $res->get_data());
}

check('plugin active', is_plugin_active('dni-growth-connector/dni-growth-connector.php'));
update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules();

$admin = 1;
wp_set_current_user($admin);
$pg_id = wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Sobre nosotros', 'post_content' => 'Hola'));
$url = get_permalink($pg_id);
check('page url', strpos($url, 'sobre-nosotros') !== false, $url);

list($s, $d) = req('GET', '/dni-growth/v1/status');
check('status 200 admin', $s === 200 && $d['version'] === '1.0.0' && $d['canLlmsTxt'] === true && $d['seoPlugin'] === null, wp_json_encode($d));

// Publishing path: REST post creation with our protected meta (what DNI Growth sends).
list($s, $d) = req('POST', '/wp/v2/posts', array('title' => 'Prueba', 'content' => 'x', 'status' => 'publish', 'meta' => array('_dni_seo_title' => 'Título <b>SEO</b>', '_dni_seo_description' => 'Desc', '_dni_jsonld' => '{"@context":"https://schema.org","@type":"Article","headline":"Prueba"}')));
check('REST create post with meta 201', $s === 201, $s . ' ' . substr(wp_json_encode($d), 0, 300));
if ($s === 201) {
	check('meta title sanitized', get_post_meta($d['id'], '_dni_seo_title', true) === 'Título SEO', get_post_meta($d['id'], '_dni_seo_title', true));
	check('meta jsonld saved', strpos(get_post_meta($d['id'], '_dni_jsonld', true), '"Article"') !== false);
}

// Fix by URL, idempotent by ref.
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'description', 'value' => 'Panadería artesana', 'url' => $url, 'ref' => 'ref-1'));
check('fix description 200', $s === 200 && $d['postId'] === $pg_id && $d['before'] === '' && $d['after'] === 'Panadería artesana', $s . ' ' . wp_json_encode($d));
$fixId = $d['id'] ?? '';
list($s, $d2) = req('POST', '/dni-growth/v1/fix', array('field' => 'description', 'value' => 'OTRO', 'url' => $url, 'ref' => 'ref-1'));
check('fix idempotent', $s === 200 && !empty($d2['repeated']) && get_post_meta($pg_id, '_dni_seo_description', true) === 'Panadería artesana');

// JSON-LD with a script-closing payload: stored, and printed escaped in <head>.
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'jsonld', 'value' => '{"@type":"Organization","name":"</script><script>alert(1)</script>"}', 'url' => $url, 'ref' => 'ref-2'));
check('fix jsonld 200', $s === 200, $s . ' ' . wp_json_encode($d));
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'jsonld', 'value' => '{no json', 'url' => $url, 'ref' => 'ref-3'));
check('invalid jsonld 400', $s === 400, (string) $s);
req('POST', '/dni-growth/v1/fix', array('field' => 'title', 'value' => 'Panadería Luna | Sobre nosotros', 'url' => $url, 'ref' => 'ref-4'));
req('POST', '/dni-growth/v1/fix', array('field' => 'canonical', 'value' => 'https://example.com/sobre-nosotros/', 'url' => $url, 'ref' => 'ref-5'));

// Front end: render <head> for the page.
$GLOBALS['wp_the_query'] = $GLOBALS['wp_query'] = new WP_Query(array('page_id' => $pg_id));
$GLOBALS['wp_query']->the_post();
do_action('wp');
ob_start();
do_action('wp_head');
$head = ob_get_clean();
check('head description', strpos($head, '<meta name="description" content="Panadería artesana" />') !== false);
check('head jsonld escaped', strpos($head, 'application/ld+json') !== false && strpos($head, '</script><script>alert') === false && strpos($head, '</script>') !== false, substr($head, strpos($head, 'ld+json'), 160));
check('head canonical ours once', substr_count($head, 'rel="canonical"') === 1 && strpos($head, 'https://example.com/sobre-nosotros/') !== false);
check('document title', wp_get_document_title() === 'Panadería Luna | Sobre nosotros', wp_get_document_title());
wp_reset_postdata();

// Undo.
list($s, $d) = req('POST', '/dni-growth/v1/fix/revert', array('post_id' => $pg_id, 'fix_id' => $fixId));
check('revert 200', $s === 200 && get_post_meta($pg_id, '_dni_seo_description', true) === '', $s . ' ' . wp_json_encode($d));
list($s, $d) = req('POST', '/dni-growth/v1/fix/revert', array('post_id' => $pg_id, 'fix_id' => $fixId));
check('revert twice repeated', $s === 200 && !empty($d['repeated']));
list($s, $d) = req('POST', '/dni-growth/v1/fix/revert', array('post_id' => $pg_id, 'fix_id' => 'nope'));
check('revert unknown 404', $s === 404);

// Image alt.
$att = wp_insert_attachment(array('post_mime_type' => 'image/jpeg', 'post_title' => 'pan', 'post_status' => 'inherit'), '/tmp/pan.jpg');
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'alt', 'value' => 'Hogaza de masa madre', 'attachment_id' => $att, 'ref' => 'ref-6'));
check('alt fix', $s === 200 && get_post_meta($att, '_wp_attachment_image_alt', true) === 'Hogaza de masa madre', $s . ' ' . wp_json_encode($d));
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'title', 'value' => 'x', 'attachment_id' => $att, 'ref' => 'ref-7'));
check('title on attachment refused', $s === 400, (string) $s);
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'title', 'value' => 'x', 'url' => home_url('/no-existe/'), 'ref' => 'ref-8'));
check('unknown url refused', $s === 403, (string) $s);

// llms.txt
list($s, $d) = req('POST', '/dni-growth/v1/llms', array('content' => "# Panadería Luna\r\n\r\n> Pan."));
check('llms 200', $s === 200 && get_option('dni_growth_llms_txt') === "# Panadería Luna\n\n> Pan." && $d['url'] === home_url('/llms.txt'), $s . ' ' . wp_json_encode($d));
list($s, $d) = req('POST', '/dni-growth/v1/llms', array('content' => ''));
check('llms revert to empty', $s === 200 && get_option('dni_growth_llms_txt') === '');

// Yoast mirror (constant defined at runtime, as when Yoast is active).
define('WPSEO_VERSION', '99');
req('POST', '/dni-growth/v1/fix', array('field' => 'description', 'value' => 'Con Yoast', 'url' => $url, 'ref' => 'ref-9'));
check('yoast mirror', get_post_meta($pg_id, '_yoast_wpseo_metadesc', true) === 'Con Yoast', get_post_meta($pg_id, '_yoast_wpseo_metadesc', true));

// Roles: editor can fix but not llms; contributor cannot fix a published page; anonymous gets 401.
$editor = wp_insert_user(array('user_login' => 'editora', 'user_pass' => wp_generate_password(), 'role' => 'editor'));
wp_set_current_user($editor);
list($s, $d) = req('GET', '/dni-growth/v1/status');
check('editor status no llms', $s === 200 && $d['canLlmsTxt'] === false);
list($s, $d) = req('POST', '/dni-growth/v1/llms', array('content' => '# x'));
check('editor llms 403', $s === 403, (string) $s);
$contrib = wp_insert_user(array('user_login' => 'colab', 'user_pass' => wp_generate_password(), 'role' => 'contributor'));
wp_set_current_user($contrib);
list($s, $d) = req('POST', '/dni-growth/v1/fix', array('field' => 'title', 'value' => 'x', 'url' => $url, 'ref' => 'ref-10'));
check('contributor fix 403', $s === 403, (string) $s);
wp_set_current_user(0);
list($s, $d) = req('GET', '/dni-growth/v1/status');
check('anonymous status 401', $s === 401, (string) $s);

// Uninstall cleans our data.
wp_set_current_user($admin);
update_option('dni_growth_llms_txt', 'x');
define('WP_UNINSTALL_PLUGIN', 'dni-growth-connector/dni-growth-connector.php');
include WP_PLUGIN_DIR . '/dni-growth-connector/uninstall.php';
check('uninstall removes option', get_option('dni_growth_llms_txt', 'GONE') === 'GONE');

$out[] = $fail === 0 ? 'ALL PASSED' : ($fail . ' FAILED');
file_put_contents('/wordpress/wpout/result.txt', implode("\n", $out) . "\n");
echo implode("\n", $out);
