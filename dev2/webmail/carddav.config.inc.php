<?php
// RCMCardDAV presets for webmail.profullstack.com.
// The login form takes any IMAP server, so the Forward Email address book is only
// set up for sessions signed in to imap.forwardemail.net. Everyone else can still
// add an address book by hand in Settings > CardDAV.
$prefs['_GLOBAL']['pwstore_scheme'] = 'des_key';
$prefs['_GLOBAL']['loglevel'] = \Psr\Log\LogLevel::WARNING;

if ((string) ($_SESSION['storage_host'] ?? '') === 'imap.forwardemail.net') {
    $prefs['forwardemail'] = [
        'accountname' => 'Forward Email',
        'discovery_url' => 'https://carddav.forwardemail.net/dav/',
        'username' => '%u',
        'password' => '%p',
        'fixed' => ['discovery_url', 'username', 'password'],
        'refresh_time' => '00:15:00',
        'active' => true,
        'readonly' => false,
    ];
}
