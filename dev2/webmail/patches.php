<?php
// Build-time source patches for plugins installed by composer. Each patch is an exact
// string replacement that must match once; the build fails if upstream changes it.
$patches = [
    // libcalendaring 3.6.1: toDateTime() re-parses a recurrence's last occurrence with
    // createFromFormat, which can return false; the next line then dies with "Attempt to
    // assign property _dateonly on false" and the whole CalDAV sync of that calendar
    // aborts (seen on a Google calendar with ~800 events). Fall back to the timestamp,
    // and return false (no end) only when there is no date at all.
    '/usr/src/roundcubemail/plugins/libcalendaring/lib/libcalendaring_recurrence.php' => [[
        <<<'OLD'
        if ($date instanceof DateTimeInterface) {
            $date = libcalendaring_datetime::createFromFormat(
                'Y-m-d\\TH:i:s',
                $date->format('Y-m-d\\TH:i:s'),
                // Sabre will loose timezone on all-day events, use the event start's timezone
                $this->start->getTimezone()
            );
        }

        $date->_dateonly = $this->dateonly;
OLD,
        <<<'NEW'
        if ($date instanceof DateTimeInterface) {
            $src = $date;
            $date = libcalendaring_datetime::createFromFormat(
                'Y-m-d\\TH:i:s',
                $date->format('Y-m-d\\TH:i:s'),
                // Sabre will loose timezone on all-day events, use the event start's timezone
                $this->start->getTimezone()
            );
            if (!$date) {
                $date = new libcalendaring_datetime('@' . $src->getTimestamp());
                $date->setTimezone($this->start->getTimezone());
            }
        }

        if (!is_object($date)) {
            return false;
        }

        $date->_dateonly = $this->dateonly;
NEW,
    ]],
];

foreach ($patches as $file => $list) {
    $src = file_get_contents($file);
    foreach ($list as [$old, $new]) {
        if (substr_count($src, $old) !== 1) {
            fwrite(STDERR, "patch does not apply to $file\n");
            exit(1);
        }
        $src = str_replace($old, $new, $src);
    }
    file_put_contents($file, $src);
    echo "patched $file\n";
}
