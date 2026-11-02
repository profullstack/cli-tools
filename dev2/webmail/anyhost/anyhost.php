<?php

/**
 * anyhost: sign in to any IMAP server from one Roundcube.
 *
 * The login form shows a free-text Server field (imap_host is '' in
 * zz-profullstack.inc.php). This plugin
 *   - defaults a blank server to Forward Email,
 *   - turns "mail.example.com" or "mail.example.com:143" into a Roundcube host URL
 *     (ssl://host:993, or tls://host:143 for STARTTLS),
 *   - refuses hosts that resolve to private, loopback or link-local addresses and ports
 *     other than 993/143, so the form cannot be used to reach the box's own services,
 *   - picks the SMTP server for the session: smtp.<rest> when the IMAP host is
 *     imap.<rest>, then the IMAP host itself, each tried on 465 (ssl) then 587 (tls).
 *
 * Source: profullstack/cli-tools dev2/webmail/anyhost (deployed to volumes/plugin-anyhost).
 */
class anyhost extends rcube_plugin
{
    const DEFAULT_IMAP = 'ssl://imap.forwardemail.net:993';
    const DEFAULT_SMTP = 'ssl://smtp.forwardemail.net:465';

    public function init()
    {
        $this->add_hook('authenticate', [$this, 'authenticate']);
        $this->add_hook('smtp_connect', [$this, 'smtp_connect']);
        $this->add_hook('template_object_loginform', [$this, 'loginform']);
        // calendar/tasklist load their own config.inc.php in init() (after this plugin) and
        // pick their driver in startup; our startup hook is registered first, so it wins.
        $this->add_hook('startup', function ($args) { $this->pick_dav_drivers(); return $args; });
    }

    /**
     * Calendar + tasks backend for this session (anyhost loads before calendar/tasklist,
     * so this runs first): Forward Email users sync with caldav.forwardemail.net; every
     * other server gets Roundcube's own database calendar (Mailu has no CalDAV).
     */
    private function pick_dav_drivers()
    {
        $config = rcmail::get_instance()->config;
        if ((string) ($_SESSION['storage_host'] ?? '') === 'imap.forwardemail.net') {
            $config->set('calendar_driver', 'caldav');
            $config->set('calendar_caldav_server', 'https://caldav.forwardemail.net');
            $config->set('tasklist_driver', 'caldav');
            $config->set('tasklist_caldav_server', 'https://caldav.forwardemail.net');
        } else {
            $config->set('calendar_driver', 'database');
            $config->set('tasklist_driver', 'database');
        }
    }

    public function loginform($args)
    {
        // A hint in the empty Server field.
        $args['content'] = preg_replace(
            '/(<input[^>]*name="_host"[^>]*?)(\s*\/?>)/',
            '$1 placeholder="imap.forwardemail.net (default)"$2',
            $args['content']
        );
        return $args;
    }

    public function authenticate($args)
    {
        $raw = trim((string) ($args['host'] ?? ''));
        if ($raw === '') {
            $args['host'] = self::DEFAULT_IMAP;
            return $args;
        }

        $host = self::parse($raw, 993);
        if (!$host) {
            return self::abort($args);
        }
        [$name, $port] = $host;
        if (!in_array($port, [993, 143], true) || !self::public_host($name)) {
            return self::abort($args);
        }
        $args['host'] = ($port === 143 ? 'tls://' : 'ssl://') . $name . ':' . $port;
        return $args;
    }

    public function smtp_connect($args)
    {
        $rcmail = rcmail::get_instance();
        $imap = (string) ($_SESSION['storage_host'] ?? '');
        if ($imap === '' || $imap === 'imap.forwardemail.net') {
            $args['smtp_host'] = self::DEFAULT_SMTP;
            return $args;
        }
        if (empty($_SESSION['anyhost_smtp'])) {
            $_SESSION['anyhost_smtp'] = self::find_smtp($imap) ?: ('ssl://' . $imap . ':465');
        }
        $args['smtp_host'] = $_SESSION['anyhost_smtp'];
        $args['smtp_user'] = $rcmail->get_user_name();
        $args['smtp_pass'] = $rcmail->get_user_password();
        return $args;
    }

    private static function find_smtp($imap)
    {
        $candidates = [];
        if (stripos($imap, 'imap.') === 0) {
            $candidates[] = 'smtp.' . substr($imap, 5);
        }
        $candidates[] = $imap;
        foreach ($candidates as $h) {
            if (!self::public_host($h)) {
                continue;
            }
            foreach ([465 => 'ssl', 587 => 'tls'] as $port => $scheme) {
                $fp = @fsockopen($h, $port, $errno, $errstr, 4);
                if ($fp) {
                    fclose($fp);
                    return "$scheme://$h:$port";
                }
            }
        }
        return null;
    }

    /** [hostname, port] from "host", "host:port" or "ssl://host:port"; null when malformed. */
    private static function parse($raw, $default_port)
    {
        $raw = preg_replace('#^[a-z]+://#i', '', $raw);
        if (!preg_match('/^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(:(\d{1,5}))?$/i', $raw, $m)) {
            return null;
        }
        return [strtolower($m[1]), isset($m[6]) ? (int) $m[6] : $default_port];
    }

    /** Every address the name resolves to is public (no RFC 1918, loopback, link-local, ULA). */
    private static function public_host($name)
    {
        $ips = [];
        foreach ((array) @dns_get_record($name, DNS_A | DNS_AAAA) as $r) {
            if (!empty($r['ip'])) $ips[] = $r['ip'];
            if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
        }
        if (!$ips) {
            $ips = (array) @gethostbynamel($name);
        }
        if (!$ips) {
            return false;
        }
        foreach ($ips as $ip) {
            if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return false;
            }
        }
        return true;
    }

    private static function abort($args)
    {
        $args['abort'] = true;
        $args['error'] = 'That mail server is not allowed. Use its public hostname, port 993 (or 143 for STARTTLS).';
        return $args;
    }
}
