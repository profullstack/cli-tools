<?php

/**
 * googlecal: connect a Google account so the Calendar tab reads and writes (create,
 * edit, delete) Google Calendar over CalDAV with OAuth 2.
 *
 * Settings > Preferences > Google Calendar: Connect / Disconnect, and a switch to keep
 * using the default calendar (Forward Email or local) while connected. When connected
 * and on, the calendar driver is caldav against apidata.googleusercontent.com and
 * libkolab's DAV client sends `Authorization: Bearer <access token>` to that host only
 * (patched in the Dockerfile). Tasks stay on the default backend: Google CalDAV has no
 * VTODO.
 *
 * The refresh token is stored in the user's prefs, encrypted with des_key. Access
 * tokens live in the session and are refreshed a minute before they expire.
 *
 * Config (zz-profullstack.inc.php): googlecal_client_id, googlecal_client_secret,
 * googlecal_redirect_uri (must match the OAuth client exactly).
 *
 * Source: profullstack/cli-tools dev2/webmail/googlecal.
 */
class googlecal extends rcube_plugin
{
    public $task = 'mail|settings|calendar|tasks|addressbook|utils';

    const AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
    const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
    const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
    const SCOPE      = 'openid email https://www.googleapis.com/auth/calendar';
    const DAV        = 'https://apidata.googleusercontent.com/caldav/v2';
    const DAV_HOST   = 'apidata.googleusercontent.com';

    private $rc;

    public function init()
    {
        $this->rc = rcmail::get_instance();
        $this->add_hook('startup', [$this, 'startup']);
        $this->register_action('plugin.googlecal-connect', [$this, 'connect']);
        $this->register_action('plugin.googlecal-callback', [$this, 'callback']);
        $this->register_action('plugin.googlecal-disconnect', [$this, 'disconnect']);
        $this->add_hook('preferences_sections_list', [$this, 'sections']);
        $this->add_hook('preferences_list', [$this, 'prefs']);
        $this->add_hook('preferences_save', [$this, 'save']);
    }

    /** Runs after anyhost's startup hook (plugin order), before calendar's. */
    public function startup($args)
    {
        $st = $this->state();
        if (!$st || !empty($st['off']) || !$this->configured()) {
            return $args;
        }
        $token = $this->access_token($st);
        if (!$token) {
            return $args;
        }
        $config = $this->rc->config;
        $config->set('calendar_driver', 'caldav');
        $config->set('calendar_caldav_server', self::DAV);
        $tokens = (array) $config->get('dav_oauth_tokens', []);
        $tokens[self::DAV_HOST] = $token;
        $config->set('dav_oauth_tokens', $tokens);
        return $args;
    }

    public function connect()
    {
        if (!$this->configured()) {
            $this->rc->output->show_message('Google Calendar is not set up on this server yet.', 'error');
            $this->rc->output->redirect(['_task' => 'settings', '_action' => 'edit-prefs', '_section' => 'googlecal']);
            return;
        }
        $_SESSION['googlecal_state'] = $state = bin2hex(random_bytes(16));
        $url = self::AUTH_URL . '?' . http_build_query([
            'client_id'              => $this->rc->config->get('googlecal_client_id'),
            'redirect_uri'           => $this->redirect_uri(),
            'response_type'          => 'code',
            'scope'                  => self::SCOPE,
            'access_type'            => 'offline',
            'prompt'                 => 'consent',
            'include_granted_scopes' => 'true',
            'state'                  => $state,
        ]);
        header('Location: ' . $url);
        exit;
    }

    public function callback()
    {
        $back = ['_task' => 'settings', '_action' => 'preferences', '_section' => 'googlecal'];
        $state = rcube_utils::get_input_string('state', rcube_utils::INPUT_GET);
        $expected = $_SESSION['googlecal_state'] ?? '';
        unset($_SESSION['googlecal_state']);
        if ($expected === '' || !hash_equals($expected, (string) $state)) {
            $this->rc->output->show_message('Google sign-in expired or was tampered with; try Connect again.', 'error');
            $this->rc->output->redirect($back);
            return;
        }
        $code = rcube_utils::get_input_string('code', rcube_utils::INPUT_GET);
        if (!$code) {
            $err = rcube_utils::get_input_string('error', rcube_utils::INPUT_GET);
            $this->rc->output->show_message('Google did not connect' . ($err ? " ($err)" : '') . '.', 'warning');
            $this->rc->output->redirect($back);
            return;
        }
        $r = $this->post(self::TOKEN_URL, [
            'code'          => $code,
            'client_id'     => $this->rc->config->get('googlecal_client_id'),
            'client_secret' => $this->rc->config->get('googlecal_client_secret'),
            'redirect_uri'  => $this->redirect_uri(),
            'grant_type'    => 'authorization_code',
        ]);
        if (empty($r['refresh_token']) || empty($r['access_token'])) {
            rcube::raise_error(['code' => 500, 'message' => 'googlecal: token exchange failed: ' . ($r['error'] ?? 'no refresh_token')], true, false);
            $this->rc->output->show_message('Google sign-in failed; try Connect again.', 'error');
            $this->rc->output->redirect($back);
            return;
        }
        $email = '';
        if (!empty($r['id_token']) && count($parts = explode('.', $r['id_token'])) === 3) {
            $claims = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
            $email = (string) ($claims['email'] ?? '');
        }
        $this->save_state(['refresh' => $r['refresh_token'], 'email' => $email, 'off' => false]);
        $_SESSION['googlecal_at'] = $r['access_token'];
        $_SESSION['googlecal_exp'] = time() + (int) ($r['expires_in'] ?? 3600);
        $this->rc->output->show_message('Google Calendar connected' . ($email ? " ($email)" : '') . '.', 'confirmation');
        $this->rc->output->redirect(['_task' => 'calendar']);
    }

    public function disconnect()
    {
        if (!$this->rc->check_request(rcube_utils::INPUT_GET)) {
            $this->rc->output->show_message('Request check failed; reload Settings and try again.', 'error');
        } elseif ($st = $this->state()) {
            $this->post(self::REVOKE_URL, ['token' => $st['refresh']]);
            $this->save_state(null);
            unset($_SESSION['googlecal_at'], $_SESSION['googlecal_exp']);
            $this->rc->output->show_message('Google Calendar disconnected.', 'confirmation');
        }
        $this->rc->output->redirect(['_task' => 'settings', '_action' => 'preferences', '_section' => 'googlecal']);
    }

    public function sections($args)
    {
        $args['list']['googlecal'] = ['id' => 'googlecal', 'section' => 'Google Calendar'];
        return $args;
    }

    public function prefs($args)
    {
        if ($args['section'] !== 'googlecal') {
            return $args;
        }
        $st = $this->state();
        $blocks = ['main' => ['name' => 'Google Calendar', 'options' => []]];
        if (!$this->configured()) {
            $blocks['main']['options']['status'] = ['title' => 'Status', 'content' => 'Not available yet: the server has no Google OAuth client configured.'];
        } elseif (!$st) {
            $link = $this->rc->url(['_task' => 'settings', '_action' => 'plugin.googlecal-connect']);
            $blocks['main']['options']['status'] = ['title' => 'Status', 'content' => 'Not connected'];
            $blocks['main']['options']['connect'] = ['title' => '', 'content' =>
                html::a(['href' => $link, 'class' => 'button mainaction', 'target' => '_top'], 'Connect Google Calendar')
                . html::p('hint', 'Your Calendar tab will show and edit your Google calendars. Tasks stay where they are.')];
        } else {
            $link = $this->rc->url(['_task' => 'settings', '_action' => 'plugin.googlecal-disconnect', '_token' => $this->rc->get_request_token()]);
            $use = new html_checkbox(['name' => '_googlecal_use', 'id' => 'googlecal_use', 'value' => 1]);
            $blocks['main']['options']['status'] = ['title' => 'Status', 'content' => rcube::Q('Connected' . (!empty($st['email']) ? ' as ' . $st['email'] : ''))];
            $blocks['main']['options']['use'] = ['title' => html::label('googlecal_use', 'Use Google as my calendar'),
                'content' => $use->show(empty($st['off']) ? 1 : 0) . html::p('hint', 'Untick to go back to your default calendar without disconnecting.')];
            $blocks['main']['options']['disconnect'] = ['title' => '', 'content' =>
                html::a(['href' => $link, 'class' => 'button', 'target' => '_top'], 'Disconnect Google')];
        }
        $args['blocks'] = $blocks;
        return $args;
    }

    public function save($args)
    {
        if ($args['section'] === 'googlecal' && ($st = $this->state())) {
            $st['off'] = empty($_POST['_googlecal_use']);
            $this->save_state($st);
        }
        return $args;
    }

    private function configured()
    {
        return $this->rc->config->get('googlecal_client_id') && $this->rc->config->get('googlecal_client_secret');
    }

    private function redirect_uri()
    {
        return $this->rc->config->get('googlecal_redirect_uri',
            'https://webmail.profullstack.com/?_task=settings&_action=plugin.googlecal-callback');
    }

    private function state()
    {
        $raw = $this->rc->config->get('googlecal_state');
        if (!$raw) {
            return null;
        }
        $st = json_decode((string) $this->rc->decrypt($raw), true);
        return is_array($st) && !empty($st['refresh']) ? $st : null;
    }

    private function save_state($st)
    {
        $value = $st ? $this->rc->encrypt(json_encode($st)) : null;
        $this->rc->user->save_prefs(['googlecal_state' => $value]);
        $this->rc->config->set('googlecal_state', $value);
    }

    private function access_token($st)
    {
        if (!empty($_SESSION['googlecal_at']) && ($_SESSION['googlecal_exp'] ?? 0) > time() + 60) {
            return $_SESSION['googlecal_at'];
        }
        $r = $this->post(self::TOKEN_URL, [
            'client_id'     => $this->rc->config->get('googlecal_client_id'),
            'client_secret' => $this->rc->config->get('googlecal_client_secret'),
            'refresh_token' => $st['refresh'],
            'grant_type'    => 'refresh_token',
        ]);
        if (empty($r['access_token'])) {
            rcube::raise_error(['code' => 500, 'message' => 'googlecal: refresh failed: ' . ($r['error'] ?? 'unknown')], true, false);
            if (($r['error'] ?? '') === 'invalid_grant') {
                // Revoked at Google or expired: forget it so the user sees "Not connected".
                $this->save_state(null);
            }
            return null;
        }
        $_SESSION['googlecal_at'] = $r['access_token'];
        $_SESSION['googlecal_exp'] = time() + (int) ($r['expires_in'] ?? 3600);
        return $r['access_token'];
    }

    private function post($url, $fields)
    {
        $ctx = stream_context_create(['http' => [
            'method'        => 'POST',
            'header'        => "Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",
            'content'       => http_build_query($fields),
            'timeout'       => 15,
            'ignore_errors' => true,
        ]]);
        $body = @file_get_contents($url, false, $ctx);
        return $body === false ? [] : (array) json_decode($body, true);
    }
}
