# webmail.profullstack.com: stock Roundcube + calendar/tasks (Kolab, CalDAV) + contacts (RCMCardDAV).
# Built on dev2 as profullstack/webmail:<tag> (see README.md); the entrypoint copies
# /usr/src/roundcubemail into /var/www/html on every fresh container.
FROM roundcube/roundcubemail:1.7.5-apache

# libkolab pins pear/http_request2 ~2.5.0, which is under CVE-2025-43717 (XSS, fixed
# 2.7.0); composer blocks it. Install the fixed 2.8.0 aliased as 2.5.1 instead of
# ignoring the advisory.

# roundcube/plugin-installer runs each plugin's SQL on install; there is no database at
# build time (SKIP_DB_INIT). The live schema is created on the box (README.md).
RUN cd /usr/src/roundcubemail \
 && SKIP_DB_INIT=1 SKIP_DB_UPDATE=1 COMPOSER_ALLOW_SUPERUSER=1 composer require --no-interaction --no-progress --update-no-dev --prefer-dist \
      "pear/http_request2:2.8.0 as 2.5.1" \
      kolab/calendar:3.6.1 kolab/tasklist:3.6.1 roundcube/carddav:5.1.5 \
 && ls plugins

# libkolab 3.6.1 sqlite.initial.sql creates ix_contact_type twice (kolab_cache_contact and
# kolab_cache_dav_contact); SQLite index names are per database, so init fails.
RUN sed -i 's/^CREATE INDEX ix_contact_type ON kolab_cache_dav_contact/CREATE INDEX ix_dav_contact_type ON kolab_cache_dav_contact/' \
      /usr/src/roundcubemail/plugins/libkolab/SQL/sqlite.initial.sql \
 && grep -c ix_dav_contact_type /usr/src/roundcubemail/plugins/libkolab/SQL/sqlite.initial.sql

# googlecal: libkolab's DAV client only does basic auth. Send `Bearer <token>` instead
# when dav_oauth_tokens has one for the request's host (Google CalDAV); every other
# server (Forward Email) keeps username/password.
RUN f=/usr/src/roundcubemail/plugins/libkolab/lib/kolab_dav_client.php \
 && sed -i 's#^            \$request->setAuth(\$this->user, \$this->password);#            $oauth = (array) $rcube->config->get("dav_oauth_tokens", []); $host = parse_url($this->url, PHP_URL_HOST);\n            if (!empty($oauth[$host])) { $request->setHeader("Authorization", "Bearer " . $oauth[$host]); } else { $request->setAuth($this->user, $this->password); }#' $f \
 && grep -c 'dav_oauth_tokens' $f

# The import dialog's Range defaulted to "1 month back", silently skipping every older
# event (and recurring series that started earlier). Default to All.
RUN f=/usr/src/roundcubemail/plugins/calendar/lib/calendar_ui.php \
 && sed -i "s#html::div('col-sm-8', \$select->show(1))#html::div('col-sm-8', \$select->show(0))#" $f \
 && grep -c "select->show(0))" $f

# Exact-match source patches (fail the build if upstream moves): see patches.php.
COPY patches.php /tmp/patches.php
RUN php /tmp/patches.php && php -l /usr/src/roundcubemail/plugins/libcalendaring/lib/libcalendaring_recurrence.php && rm /tmp/patches.php

COPY --chmod=755 googlecal /usr/src/roundcubemail/plugins/googlecal
COPY --chmod=644 carddav.config.inc.php /usr/src/roundcubemail/plugins/carddav/config.inc.php
