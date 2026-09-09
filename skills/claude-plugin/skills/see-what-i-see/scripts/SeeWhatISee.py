#!/usr/bin/env python3
"""SeeWhatISee.py — single backend script for all see-what-i-see skills.

All actions a skill can take collapse to flags on this one script:
  --stop                   Kill any existing watcher (implies --pid-lockfile).
  --get-latest (default)   Emit the current last record from log.json.
  --all / --limit N        Emit records from the whole capture history.
  --watch                  Watch log.json and emit new records.

Multiple actions combine and run in that order.

History spans more than log.json: the extension keeps only the most
recent captures there and moves older ones into `history-*.json` files
beside it (see src/capture/log-store.ts). --all reads those history
files oldest-first and then log.json. --limit N instead walks from
log.json backwards through them and stops as soon as it has N records,
so it opens only the files it needs. Either way the emitted
stream is in capture order, oldest first. --search / --filter_site /
--filter_time narrow it. They narrow only the records listed from
history; records that arrive later under --watch are emitted
regardless.

A --pid-lockfile watcher also publishes its presence to the extension
and can be stopped from the Capture page; see docs/watch-protocol.md.

Source-dir resolution (used for both reading log.json and writing the
pidfile) is the same regardless of action:
  --directory DIR         explicit override, used as-is.
  else .SeeWhatISee in .  parsed for `directory=...`.
  else $HOME/.SeeWhatISee same.
  else default            $HOME/Downloads/SeeWhatISee.
$SNAP_REAL_HOME is used instead of $HOME if set (snap installs of
Gemini CLI mangle $HOME).

Output: each emitted record is the log.json record re-serialized with
filenames rewritten to absolute paths pointing into the source dir
(or the --copy-to-dir directory). Records are emitted as JSONL, one per
line. --print_selection appends a `Selection:` block after the record it
belongs to.

With --copy-to-dir, the referenced files are first copied into that dir and the
rewritten paths point there instead of the source dir; this lets Gemini CLI
(which can only read its own workspace tmp dir) consume captures the extension
wrote into ~/Downloads/SeeWhatISee.

This script uses only the Python standard library, so installing a
skill bundle is just copying its files.

Wrappers under each skill customized for each AI tool just `exec` this
script with the right defaults.
See skills/*/skills/*/scripts/*.sh for the wrappers.
"""

import errno
import json
import os
import re
import shutil
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

# How many records a filter emits when neither --all nor --limit says
# otherwise. Keep in sync with the usage text below and
# with docs/cli_commands.md, which can't interpolate it.
SEARCH_DEFAULT_LIMIT = 10

# Artifact fields whose `filename` is a bare name in log.json and an
# absolute path in what we emit.
ARTIFACT_KEYS = ("screenshot", "contents", "selection")

POLL_SECONDS = 0.5

# Files in the source dir that coordinate who is watching, and let the
# extension show and stop us (see docs/watch-protocol.md).
#
# `.watch-status.json` is the live record of a stoppable watcher: its
# pid, when it started, and a heartbeat. The Capture page asks us to
# exit by dropping `watch-stop.json` beside it.
#
# `.watch.pid` is the original lock — one line, the pid — and is now
# **deprecated**, written only so older versions of this script can
# still find and replace us. Its format is frozen: old code parses the
# whole file as an integer. Nothing here reads it except `watcher_pid`'s
# fallback, so later we could stop writing this file.
STATUS_FILE = ".watch-status.json"
PID_FILE = ".watch.pid"
# The odd one out, with no leading dot: the extension can only put a
# file on disk through the downloads API, which refuses a leading-dot
# filename outright ("Invalid filename").
STOP_FILE = "watch-stop.json"

# How often the status file's `heartbeat` is refreshed. A heartbeat
# that has gone quiet is how the extension spots a watcher killed with
# SIGKILL (or a machine that lost power) that never got to clean its
# files up.
HEARTBEAT_SECONDS = 30

# Exit code for "a stop was requested, and honoured", used by a
# single-shot watcher: its caller is an agent that re-runs it once per
# capture, so "stop" has to be distinguishable from "here is your
# capture" (0) and from an error. A --loop watcher just exits 0 — the
# process ending is itself the end of the watch.
EXIT_STOPPED = 3

# "Please exit" signals, sent by one copy of this script to another —
# SIGUSR1 for a stop request (`--stop`, i.e. /see-what-i-see-stop),
# SIGUSR2 when a new watcher takes the slot. A watcher catches them and
# shuts down the same way it answers `watch-stop.json`: files released,
# a message saying which happened, EXIT_STOPPED.
#
# Both were picked because their *default* disposition is to terminate
# the process, so a watcher from an older bundle — which installs no
# handler — still dies. See docs/watch-protocol.md for the rest of the
# reasoning.
STOP_SIGNAL = signal.SIGUSR1
TAKEOVER_SIGNAL = signal.SIGUSR2

USAGE = """\
Usage: SeeWhatISee.py [ACTIONS] [OPTIONS]

Actions (combinable; run in this order):
  --stop               Kill any existing watcher (implies --pid-lockfile).
  --get-latest         Emit the current last record (default if no action
                       given). Cannot be combined with the history actions
                       below.
  --all                Emit every record in the capture history, oldest first.
  --limit N            Emit up to the N most recent records, oldest first.
  --watch              Watch log.json and emit new records as they arrive.

Options for the history listing:
  --search "words"     Show records where all words in the search string
                       appear in the url, title, or prompt (case-insensitive).
  --filter_site "str"  Show records whose http hosts contain this
                       substring (case-insensitive).
  --filter_time SPAN   Show records captured within SPAN (see below).

Filters without --all or --limit default to --limit 10.
Filters apply to history records but not to future records from --watch.

--filter_time spans:
  A span is one point, or a range of points written with `..`.
  Leaving an end off opens that end.
    2026-04-08               that day
    2026-04                  that month
    2026-04-08..2026-04-14   that date range, both ends included
    14:30..                  since 14:30 today
    ..2026-04-08 17          until the 17:00 hour that day
  A point is a date, a time, or both, or any partial prefix.
    2026-04-08 20:30:12.345  a full timestamp from the log
    2026-04-08 20            that full hour
    14:30                    that minute today
    yesterday 14:30          that minute yesterday
    20260822-132959          the compact format used in capture filenames
  Times are local unless the value ends in `z`, which means UTC.
  Date and time may be separated with space or `t`.

General options:
  --directory DIR      Source dir to read log.json from. If unset, read
                       .SeeWhatISee config file (in . then $HOME) with a
                       `directory=...` line; otherwise defaults to
                       $HOME/Downloads/SeeWhatISee.
  --copy-to-dir DIR    Copy each emitted record's referenced files into DIR
                       before emitting, and rewrite paths to point under DIR.
                       By default, emitted paths point into the source dir.
  --print_selection    For records with a `selection` artifact, append its
                       file contents after the JSON line.
  --help               Show this help and exit.

Options for --watch:
  --pid-lockfile       Write $SOURCE_DIR/{.watch-status.json, .watch.pid} so
                       --stop or a subsequent --watch can find and replace
                       this watcher. Also exits when watch-stop.json appears
                       beside them, which is how the extension's Capture page
                       stops this watcher. --stop and a replacement watcher
                       ask by signal instead. A watcher stopped any of those
                       ways exits 0 with --loop, and 3 without it (where
                       exiting 0 would look like "here is your capture" to
                       the caller).
  --loop               Keep polling after each emission; default is to exit
                       after the first.
  --after TIMESTAMP    Before polling, emit the record(s) that follow the last
                       record with TIMESTAMP in log.json. TIMESTAMP must match
                       an existing record's `timestamp` field exactly.
  --catch-up-one       Constrain --after to emit just a single record, not all
                       available records.
                       Mutually exclusive with --loop.
"""


def die(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
#
# Hand-rolled rather than argparse: the flag surface is small, and the
# skills (and their tests) depend on these exact messages and exit codes,
# which argparse words its own way.


class Options:
    def __init__(self):
        self.get_latest = False
        self.list = False
        self.watch = False
        self.stop = False
        self.all = False
        self.limit = None          # None = unlimited
        self.search = None         # None = flag absent, "" = given but empty
        self.filter_site = None
        self.filter_time = None
        self.time_span = None      # Span, set by validate()
        self.directory = None
        self.copy_to_dir = None
        self.pid_lockfile = False
        self.loop = False
        self.after = None
        self.catch_up_one = False
        self.print_selection = False


def parse_args(argv):
    opts = Options()
    any_action = False

    def value(flag, rest):
        if not rest:
            die("Error: %s needs a value" % flag, 2)
        return rest.pop(0)

    rest = list(argv)
    while rest:
        arg = rest.pop(0)
        # --flag=value: hand the value to rest so the branches below
        # can pop it like any other.
        given = arg
        inline = None
        if arg.startswith("--") and "=" in arg:
            arg, inline = arg.split("=", 1)
            rest.insert(0, inline)
        unconsumed = len(rest)
        if arg == "--help":
            if inline is not None:
                die("Error: --help takes no value", 2)
            print(USAGE, end="")
            sys.exit(0)
        elif arg == "--get-latest":
            opts.get_latest = any_action = True
        elif arg == "--all":
            opts.all = opts.list = any_action = True
        elif arg == "--limit":
            opts.limit = value(arg, rest)
            opts.list = any_action = True
        elif arg == "--search":
            opts.search = value(arg, rest)
            any_action = True
        elif arg == "--filter_site":
            opts.filter_site = value(arg, rest)
            any_action = True
        elif arg == "--filter_time":
            opts.filter_time = value(arg, rest)
            any_action = True
        elif arg == "--watch":
            opts.watch = any_action = True
        elif arg == "--stop":
            opts.stop = opts.pid_lockfile = any_action = True
        elif arg == "--directory":
            opts.directory = value(arg, rest)
        elif arg == "--copy-to-dir":
            opts.copy_to_dir = value(arg, rest)
        elif arg == "--pid-lockfile":
            opts.pid_lockfile = True
        elif arg == "--loop":
            opts.loop = True
        elif arg == "--after":
            opts.after = value(arg, rest)
        elif arg == "--catch-up-one":
            opts.catch_up_one = True
        elif arg == "--print_selection":
            opts.print_selection = True
        else:
            print("Unknown option: %s" % given, file=sys.stderr)
            print(USAGE, end="", file=sys.stderr)
            sys.exit(2)

        if inline is not None and len(rest) == unconsumed:
            die("Error: %s takes no value" % arg, 2)

    if not any_action:
        opts.get_latest = True

    # The filters narrow a history listing, so on their own they mean
    # "list the history, filtered". They default to the most recent 10
    # matches rather than --all: a bare search is an interactive "what
    # did I capture about X" question, and dumping a whole history of
    # matches at an agent is rarely what was wanted. Ask for --all to
    # get the rest.
    filtering = any(getattr(opts, name) is not None
                    for name in ("search", "filter_site", "filter_time"))
    if filtering and not opts.list:
        opts.limit = str(SEARCH_DEFAULT_LIMIT)
        opts.list = True

    validate(opts)
    return opts


def validate(opts):
    # These three modify watch behavior only — passing them without
    # --watch would silently do nothing, which is the kind of "looks
    # like it worked" failure that wastes debugging time.
    if not opts.watch:
        if opts.after is not None:
            die("Error: --after only applies with --watch", 2)
        if opts.loop:
            die("Error: --loop only applies with --watch", 2)
        if opts.catch_up_one:
            die("Error: --catch-up-one only applies with --watch", 2)
    # --catch-up-one is the Gemini single-shot pattern ("emit at most
    # one then exit"); --loop says "keep polling forever".
    if opts.catch_up_one and opts.loop:
        die("Error: --catch-up-one and --loop are mutually exclusive", 2)
    # "everything" and "at most N" are contradictory asks.
    if opts.all and opts.limit is not None:
        die("Error: --all and --limit are mutually exclusive", 2)
    # --get-latest is "the one newest record" — already what a listing
    # of the newest record(s) gives, and with different empty-history
    # behavior. Combining them would emit the newest record twice.
    if opts.get_latest and opts.list:
        die("Error: --get-latest cannot be combined with --all / --limit "
            "or a filter", 2)
    if opts.limit is not None and not re.fullmatch(r"[1-9][0-9]*", opts.limit):
        die("Error: --limit takes a positive integer, got '%s'" % opts.limit, 2)
    # A filter with nothing in it is a caller bug — an agent
    # interpolating an empty query string, most likely. Matching
    # everything (or nothing) and exiting 0 would look like a real
    # answer, so say so instead.
    if opts.search is not None and not opts.search.strip():
        die("Error: --search needs at least one non-whitespace character", 2)
    if opts.filter_site is not None and not opts.filter_site.strip():
        die("Error: --filter_site needs at least one non-whitespace character",
            2)
    if opts.filter_time is not None:
        if not opts.filter_time.strip():
            die("Error: --filter_time needs at least one non-whitespace "
                "character", 2)
        # Parsed here rather than at match time so a malformed span is a
        # startup error, not a listing that quietly matches nothing.
        opts.time_span = parse_span(opts.filter_time)


# ---------------------------------------------------------------------------
# Source dir resolution
# ---------------------------------------------------------------------------


def parse_config(path):
    """Return the `directory=` value from a .SeeWhatISee file, or None.

    Any other setting is an error rather than a no-op: a typo'd key in a
    config file the user wrote by hand should say so.
    """
    directory = None
    with open(path, encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("directory="):
                directory = line[len("directory="):]
                quoted = (len(directory) >= 2
                          and directory[0] == directory[-1]
                          and directory[0] in "\"'")
                if quoted:
                    directory = directory[1:-1]
            else:
                die("Error: unrecognized option in %s line %d: %s"
                    % (path, line_no, line))
    return directory


def resolve_dir(opts):
    if opts.directory:
        return opts.directory
    # Snap-installed Gemini CLI mangles $HOME, so honor its escape hatch
    # for the paths we *default* off the home dir.
    home = os.environ.get("SNAP_REAL_HOME") or os.environ.get("HOME", "")
    for candidate in (".SeeWhatISee", os.path.join(home, ".SeeWhatISee")):
        if os.path.isfile(candidate):
            directory = parse_config(candidate)
            if directory:
                return directory
            # The nearest config file wins even when it sets no
            # directory: a project-local .SeeWhatISee is a deliberate
            # statement about this directory, so falling back past it
            # to the home one would ignore what the user wrote.
            break
    return os.path.join(home, "Downloads", "SeeWhatISee")


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------


class Emitter:
    """Turns log records into the script's stdout format.

    One object holds everything the emit path needs — where files are
    read from, where emitted paths point, whether to copy — so the
    per-record work is a method call rather than a pipeline.
    """

    def __init__(self, opts, source_dir):
        self.source_dir = source_dir
        self.print_selection = opts.print_selection
        self.copy_to_dir = opts.copy_to_dir
        self.out_dir = opts.copy_to_dir or source_dir
        if opts.copy_to_dir:
            os.makedirs(opts.copy_to_dir, exist_ok=True)

    def emit(self, record, raw=None):
        """Print one record as JSONL, plus its selection when asked.

        `raw` is the original line, printed verbatim when the record
        didn't parse — a capture the user just took is worth handing
        over even if something upstream wrote a line we can't read.
        """
        if record is None:
            print(raw)
            return
        if self.copy_to_dir:
            self._copy_artifacts(record)
        self._absolutize(record)
        print(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
        if self.print_selection:
            self._print_selection(record)

    def _artifact_name(self, record, key):
        artifact = record.get(key)
        if isinstance(artifact, dict):
            filename = artifact.get("filename")
            if isinstance(filename, str):
                return filename
        return None

    def _copy_artifacts(self, record):
        for key in ARTIFACT_KEYS:
            name = self._artifact_name(record, key)
            # The extension always writes bare names; absolute means we
            # already rewrote it on a previous pass — don't re-copy.
            if not name or name.startswith("/"):
                continue
            source = os.path.join(self.source_dir, name)
            if os.path.isfile(source):
                shutil.copy2(source, os.path.join(self.out_dir, name))

    def _absolutize(self, record):
        for key in ARTIFACT_KEYS:
            name = self._artifact_name(record, key)
            if name and not name.startswith("/"):
                record[key]["filename"] = os.path.join(self.out_dir, name)

    def _print_selection(self, record):
        path = self._artifact_name(record, "selection")
        if not path or not os.path.isfile(path):
            return
        with open(path, encoding="utf-8", errors="replace") as handle:
            body = handle.read()
        # The trailing newline terminates the block, so the next
        # record's JSON starts on its own line even when the selection
        # file doesn't end in one.
        sys.stdout.write("\nSelection:\n" + body + "\n")


def parse_record(line):
    """Parse one JSONL line, or None if it isn't a JSON object.

    Lenient on purpose, matching `parseLogText` on the extension side:
    these files sit in the user's Downloads folder where they can be
    edited, truncated mid-write, or concatenated.
    """
    line = line.strip()
    if not line:
        return None
    try:
        record = json.loads(line)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def read_records(path):
    """Every parseable record in one file, in file order."""
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError as err:
        die("Error: cannot read %s: %s" % (path, err.strerror), 2)
    return [record for record in map(parse_record, lines) if record is not None]


def read_lines(path):
    """Every non-empty line of a file, in file order.

    Unreadable reads as empty rather than fatal, unlike the readers
    above: its caller is the poll loop, which holds a cursor and so
    recovers on the next poll. Anything one-shot wants the error.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return [line for line in handle.read().splitlines() if line.strip()]
    except OSError:
        return []


def read_last_line(path):
    """The last non-empty line of a file, or None."""
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = [line for line in handle.read().splitlines() if line.strip()]
    return lines[-1] if lines else None


# ---------------------------------------------------------------------------
# History files
# ---------------------------------------------------------------------------


def history_files(source_dir, log_path):
    """The files holding the capture history, oldest first.

    Each history file is named for *when it was written*, using the
    same zero-padded `YYYYMMDD-HHMMSS-mmm` stamp as capture filenames,
    so the names are fixed-width and sorting them is chronological —
    which the `--limit` walk below depends on, not just the display
    order. Only stamp-shaped names (digits and hyphens) count: a
    word-y `history-notes.json` is someone else's file, and would land
    at an arbitrary spot in that order. The extension's directory
    listing applies the same rule (`HISTORY_FILE_TOKEN`); keep the two
    in step.
    """
    try:
        names = os.listdir(source_dir)
    except OSError:
        names = []
    older = [name for name in names
             if re.fullmatch(r"history-[\d-]*\.json", name)]
    older.sort()
    files = [os.path.join(source_dir, name) for name in older]
    if os.path.isfile(log_path):
        files.append(log_path)
    return files


# ---------------------------------------------------------------------------
# --filter_time parsing
# ---------------------------------------------------------------------------
#
# A value names a span, never an instant: every accepted form has a
# resolution, and it matches from the start of that unit to the end of
# it. `2026-04` is April; `14:` is the 14:00 hour today. A range
# START..END runs from the start of START's unit to the end of END's.
#
# `..` is the range separator because `-` and `:` both occur inside the
# values themselves — in `2026-04-08T20:30..2026-04-08T21:00` a `:`
# separator would sit between two digits exactly like the one in
# `20:30`, with nothing to tell them apart. A `.` only ever appears
# before fractional seconds, and never doubled.

# Time of day. The minutes and seconds are each optional so `20:` is
# the hour and `20:30` the minute, matching the span rule above.
TIME_PATTERN = (r"(?P<h>\d{1,2})"
                r"(?::(?:(?P<mi>\d{1,2})"
                r"(?::(?P<s>\d{1,2})(?:\.(?P<ms>\d{1,3}))?)?)?)?")

POINT_PATTERNS = (
    # `today` / `yesterday`, optionally with a time. The date is
    # already established, so the time needs no colon: `today 14` is
    # the 14:00 hour. Only whitespace separates them — a `t` would
    # read as part of the word.
    re.compile(r"(?P<kw>today|yesterday)(?:\s+%s)?(?P<z>z)?" % TIME_PATTERN),
    # A date, optionally with a time after a `t` or whitespace
    # separator. The separator is required: without it `2026-04-0820`
    # would parse as a date plus an hour.
    re.compile(r"(?P<y>\d{4})(?:-(?P<mo>\d{1,2})(?:-(?P<d>\d{1,2}))?)?"
               r"(?:(?:t|\s+)%s)?(?P<z>z)?" % TIME_PATTERN),
    # A time by itself, meaning today. The colon is what identifies it
    # as a time at all — a bare `3` would be indistinguishable from a
    # (malformed) year, so it is rejected rather than guessed at.
    re.compile(r"(?P<h>\d{1,2}):(?:(?P<mi>\d{1,2})"
               r"(?::(?P<s>\d{1,2})(?:\.(?P<ms>\d{1,3}))?)?)?(?P<z>z)?"),
    # The compact stamp capture filenames carry, as in
    # `screenshot-20260822-132959-259.png`, so one can be pasted
    # straight out of a filename. Its fields are fixed-width and run
    # together, which is what tells it apart from the dashed forms
    # above: a leading digit run longer than four can only be this
    # (six is the shortest one, `YYYYMM`).
    # Each field nests inside the one before it, so a stamp can only
    # be truncated from the right — the only shapes a filename can
    # actually produce.
    # Filenames stamp local time (see src/capture/types.ts), which is
    # the default here anyway; a trailing `z` still overrides, so the
    # zone rule stays the same across every form.
    re.compile(r"(?P<y>\d{4})(?P<mo>\d{2})(?:(?P<d>\d{2})"
               r"(?:-(?P<h>\d{2})(?:(?P<mi>\d{2})"
               r"(?:(?P<s>\d{2})(?:-(?P<ms>\d{3}))?)?)?)?)?(?P<z>z)?"),
)

# Finest-to-coarsest, so the last field present in a value gives its
# resolution.
UNITS = ("ms", "s", "mi", "h", "d", "mo", "y")


def parse_span(value):
    """--filter_time value -> a Span.

    Both bounds stay naive wall-clock times, read in the zone the value
    asks for; matching converts each record into that same zone. That
    keeps daylight-saving transitions out of the arithmetic entirely —
    see Span.holds.
    """
    text = value.strip().lower()
    if ".." in text:
        left, _, right = text.partition("..")
        if ".." in right:
            die("Error: --filter_time: '%s' has more than one '..'" % value, 2)
        # Each side is stripped separately: `2026-04 .. 2026-05` is the
        # natural way to type a range, and the inner spaces of a
        # `2026-04-08 20` endpoint have to survive.
        left, right = left.strip(), right.strip()
        if not left and not right:
            die("Error: --filter_time: '..' needs a date or time on at "
                "least one end", 2)
        first = parse_point(left, value) if left else None
        last = parse_point(right, value) if right else None
    else:
        # A lone point spans its own unit, so both ends come from it.
        first = last = parse_point(text, value)

    # A range half in local time and half in UTC is far more often a
    # forgotten `z` than a deliberate mix, and the mistake silently
    # shifts one end of the window by the zone offset.
    if first is not None and last is not None and first.utc != last.utc:
        die("Error: --filter_time: '%s' mixes local and UTC ends; mark both "
            "with a trailing z or neither" % value, 2)

    start = first.start if first is not None else None
    end = last.end if last is not None else None
    if start is not None and end is not None and start >= end:
        die("Error: --filter_time: '%s' ends before it starts" % value, 2)
    return Span(start, end, (first or last).utc)


class Point:
    """One end of a span: the naive bounds of the unit it names."""

    def __init__(self, start, end, utc):
        self.start = start
        self.end = end
        self.utc = utc


class Span:
    """A --filter_time window, as wall-clock bounds plus their zone."""

    def __init__(self, start, end, utc):
        self.start = start          # naive, inclusive; None = unbounded
        self.end = end              # naive, exclusive; None = unbounded
        self.utc = utc

    def holds(self, moment):
        """Is this instant (an aware datetime) inside the span?

        The comparison runs on wall-clock readings in the span's own
        zone rather than on converted bounds, which is what makes
        daylight-saving transitions behave. A local day is simply every
        instant that reads as that date, so it is 23 or 25 hours long as
        the zone requires; an hour that runs twice matches both times;
        and an hour that never happens matches nothing, instead of
        silently resolving to a neighboring hour the way converting the
        bounds would.
        """
        wall = moment.astimezone(timezone.utc if self.utc else None)
        wall = wall.replace(tzinfo=None)
        if self.start is not None and wall < self.start:
            return False
        if self.end is not None and wall >= self.end:
            return False
        return True


def parse_point(text, value):
    for pattern in POINT_PATTERNS:
        match = pattern.fullmatch(text)
        if match:
            break
    else:
        die("Error: --filter_time: cannot parse '%s' in '%s'" % (text, value),
            2)

    parts = match.groupdict()
    utc = bool(parts.get("z"))
    fields = {name: int(parts[name])
              for name in ("y", "mo", "d", "h", "mi", "s")
              if parts.get(name) is not None}
    if parts.get("ms") is not None:
        # Zero-padded on the right: `.3` is 300ms, as in an ISO timestamp.
        fields["ms"] = int(parts["ms"].ljust(3, "0"))

    if "y" not in fields:
        # `today` / `yesterday`, or a bare time. Either way the date is
        # "now" in whichever zone the value is written in, so `14:z`
        # is the 14:00 UTC hour of today's UTC date.
        now = datetime.now(timezone.utc if utc else None)
        if parts.get("kw") == "yesterday":
            now -= timedelta(days=1)
        # Whatever time fields were given; the date fields are implied
        # and so never set the resolution.
        given = [name for name in UNITS if name in fields]
        fields["y"], fields["mo"], fields["d"] = now.year, now.month, now.day
        unit = given[0] if given else "d"
    else:
        unit = next(name for name in UNITS if name in fields)

    try:
        start = datetime(fields["y"], fields.get("mo", 1), fields.get("d", 1),
                         fields.get("h", 0), fields.get("mi", 0),
                         fields.get("s", 0), fields.get("ms", 0) * 1000)
    except ValueError as err:
        die("Error: --filter_time: '%s' is not a real date or time (%s)"
            % (text, err), 2)
    return Point(start, advance(start, unit), utc)


def advance(start, unit):
    """The start of the unit after the one `start` opens."""
    if unit == "y":
        return start.replace(year=start.year + 1)
    if unit == "mo":
        if start.month == 12:
            return start.replace(year=start.year + 1, month=1)
        return start.replace(month=start.month + 1)
    return start + {
        "d": timedelta(days=1),
        "h": timedelta(hours=1),
        "mi": timedelta(minutes=1),
        "s": timedelta(seconds=1),
        "ms": timedelta(milliseconds=1),
    }[unit]


def record_time(record):
    """A record's `timestamp` as an aware datetime, or None."""
    stamp = record.get("timestamp")
    if not isinstance(stamp, str):
        return None
    if stamp.endswith(("z", "Z")):
        stamp = stamp[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(stamp)
    except ValueError:
        return None
    # log.json always writes UTC; a record hand-edited to drop the `Z`
    # is read the same way rather than as local time.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# History listing
# ---------------------------------------------------------------------------


def matches(record, terms, site, span):
    """Does one record pass --search / --filter_site / --filter_time?

    The search rule mirrors the History page's box (src/history.ts):
    every term must appear somewhere in url / title / prompt, in any
    field and any order. `span` is the Span from --filter_time, or None.
    """
    if site:
        url = record.get("url")
        if not isinstance(url, str):
            return False
        parts = urlsplit(url)
        # Only http(s) URLs have a site to match, so file:// and
        # chrome:// captures never match.
        if parts.scheme not in ("http", "https"):
            return False
        host = parts.netloc.lower().rsplit("@", 1)[-1]   # drop any userinfo
        if site not in host:
            return False
    if terms:
        haystack = "\n".join(
            record[field] for field in ("url", "title", "prompt")
            if isinstance(record.get(field), str)
        ).lower()
        if not all(term in haystack for term in terms):
            return False
    if span is not None:
        when = record_time(record)
        # A record whose timestamp won't parse can't be placed in time,
        # so it can't satisfy a time filter.
        if when is None or not span.holds(when):
            return False
    return True


def list_history(opts, emitter, source_dir, log_path):
    """--all / --limit, narrowed by the --search / --filter_* options.

    An empty history is not an error here: unlike --get-latest, which
    exists to hand the agent one specific capture, a listing of an empty
    history is legitimately empty.
    """
    terms = opts.search.lower().split() if opts.search else []
    site = opts.filter_site.lower() if opts.filter_site else ""
    span = opts.time_span
    files = history_files(source_dir, log_path)
    limit = int(opts.limit) if opts.limit else 0

    if not limit:
        for path in files:
            for record in read_records(path):
                if matches(record, terms, site, span):
                    emitter.emit(record)
        return

    # Walk from the newest file and stop as soon as we have enough, so
    # `--limit 10` on a long history opens one file rather than all of
    # them. Each file is scanned back-to-front, and the collected
    # newest-first records are reversed at the end.
    collected = []
    for path in reversed(files):
        for record in reversed(read_records(path)):
            if matches(record, terms, site, span):
                collected.append(record)
                if len(collected) == limit:
                    break
        if len(collected) == limit:
            break
    for record in reversed(collected):
        emitter.emit(record)


# ---------------------------------------------------------------------------
# Watcher lifecycle
# ---------------------------------------------------------------------------


def remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def valid_pid(value):
    """`value` if it is a pid we are willing to signal, else None.

    `os.kill(0, ...)` signals our whole process group — for a watcher
    started by an agent, that can be the agent itself — and a negative
    pid signals some other group, so a corrupt or hand-edited file must
    never reach `os.kill`. Booleans are ints in Python; exclude them.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value > 1 else None


def read_pid(pidfile):
    try:
        with open(pidfile, encoding="utf-8") as handle:
            return valid_pid(int(handle.read().strip()))
    except (OSError, ValueError):
        return None


def pid_alive(pid):
    """Whether a process with this pid exists. Signal 0 only checks."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def kill_pid(pid, request):
    """Ask a watcher to exit, escalating until it does.

    `request` is the polite signal — STOP_SIGNAL or TAKEOVER_SIGNAL —
    which a current watcher turns into a clean shutdown and an older
    one dies of anyway. SIGTERM then SIGKILL follow for a watcher
    wedged somewhere its handler can't run. The request gets the
    longest wait, being the only stage that ends in a clean exit code.

    True if it was alive to be signalled, False if there was nothing
    there — a pid nobody is using any more reads as "already stopped".
    """
    if pid is None or not pid_alive(pid):
        return False
    for sig, patience in ((request, 2.0),
                          (signal.SIGTERM, 0.5),
                          (signal.SIGKILL, 0.5)):
        try:
            os.kill(pid, sig)
        except OSError as error:
            # ESRCH is the one that means "gone", i.e. stopped. Anything
            # else (EPERM, against a pid that is now someone else's)
            # leaves something running that we have not stopped, and
            # escalating would only aim more signals at a stranger.
            return error.errno == errno.ESRCH
        deadline = time.monotonic() + patience
        while pid_alive(pid):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        else:
            return True
    return True


def iso_now():
    """UTC timestamp the extension's `Date.parse` reads without guessing."""
    return datetime.now(timezone.utc).isoformat(
        timespec="seconds").replace("+00:00", "Z")


def status_pid(status_path):
    """The pid the status file names, or None if there isn't one.

    Anything else the file might hold — missing, unreadable, not JSON,
    JSON that isn't an object, an object without a numeric `pid` — is
    the same answer: nobody is named here. This runs on the exit path
    of every watcher, so it must not raise.
    """
    try:
        with open(status_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return valid_pid(data.get("pid"))


def write_status(status_path, started):
    """Publish (or refresh) the status file the Capture page polls.

    Written to a temp file and renamed into place: the page reads it on
    a timer, and catching a half-written file would read as "no watcher
    is running" and flicker its Stop button away.

    Silent on failure — a status file we can't write costs the Capture
    page's button, never the watching itself.
    """
    tmp = "%s.%d.tmp" % (status_path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"pid": os.getpid(),
                       "started": started,
                       "heartbeat": iso_now()}, handle)
            handle.write("\n")
        os.replace(tmp, status_path)
    except OSError:
        remove_quietly(tmp)


def clear_if_gone(path, named_pid, stopped_pid):
    """Delete a watcher file that no live watcher stands behind.

    Left alone when it names a different, still-running process: that
    is a watcher racing us for the slot, and its own exit will clean up
    after it.
    """
    if named_pid is None or named_pid == stopped_pid or not pid_alive(named_pid):
        remove_quietly(path)


def watcher_pid(source_dir):
    """The pid of the watcher holding the slot, or None if there isn't one.

    Normally that pid comes from `.watch-status.json`. Falling back to
    `.watch.pid` covers one case: a watcher started by a version of
    this script old enough that it never wrote the status file.
    """
    pid = status_pid(os.path.join(source_dir, STATUS_FILE))
    if pid is not None and pid_alive(pid):
        return pid
    # A status file naming a dead pid must not mask the pidfile: an
    # older watcher leaves the corpse's file alone when it takes the
    # slot, and reading only that would report nothing to stop while it
    # keeps running. Falling back to the dead pid keeps the caller able
    # to clear the file it left behind.
    return read_pid(os.path.join(source_dir, PID_FILE)) or pid


def clear_status_temps(source_dir):
    """Remove `.watch-status.json.<pid>.tmp` files left by a hard kill."""
    prefix = STATUS_FILE + "."
    try:
        names = os.listdir(source_dir)
    except OSError:
        return
    for name in names:
        if name.startswith(prefix) and name.endswith(".tmp"):
            remove_quietly(os.path.join(source_dir, name))


def clear_watch_files(source_dir, stopped_pid):
    """Drop the files of a watcher that is gone.

    Each file is judged by the pid it names, so a racing fresh watcher
    that has already rewritten one of them keeps it. `stopped_pid` is
    the watcher we just stopped, or None when we never identified one —
    then only files nothing live stands behind are cleared.
    """
    status_path = os.path.join(source_dir, STATUS_FILE)
    pidfile = os.path.join(source_dir, PID_FILE)
    clear_if_gone(status_path, status_pid(status_path), stopped_pid)
    clear_if_gone(pidfile, read_pid(pidfile), stopped_pid)


def stop_watcher(source_dir):
    """--stop: kill the running watcher and clear the files it leaves.

    True if a live watcher was found, False if not.
    """
    pid = watcher_pid(source_dir)
    stopped = kill_pid(pid, STOP_SIGNAL)
    clear_watch_files(source_dir, pid)
    # SIGKILLing a watcher mid-write is one of the two ways an orphaned
    # temp file appears, and this is the path that does it.
    clear_status_temps(source_dir)
    # Whatever the Capture page asked for, this satisfies it — and a
    # request nobody answered must not stop the *next* watcher.
    remove_quietly(os.path.join(source_dir, STOP_FILE))
    return stopped


def claim_watch_slot(source_dir, loop):
    """Take over the watcher slot, and give it back however we exit.

    `loop` is the watcher's own --loop setting, which decides the exit
    code a stop request gets — the same split the `watch-stop.json`
    path makes.

    Returns the start timestamp to stamp the status file with.
    """
    pidfile = os.path.join(source_dir, PID_FILE)
    status_path = os.path.join(source_dir, STATUS_FILE)
    previous = watcher_pid(source_dir)
    kill_pid(previous, TAKEOVER_SIGNAL)
    clear_watch_files(source_dir, previous)
    # `write_status` unlinks its own temp file when the write fails,
    # but a watcher killed mid-write leaves one behind for good. We
    # have just stopped whoever held the slot, so any that remain are
    # nobody's.
    clear_status_temps(source_dir)
    # Any stop request predates us, so it was never aimed at us.
    remove_quietly(os.path.join(source_dir, STOP_FILE))
    # Pidfile before status file, deliberately: an older --stop reads
    # only the pidfile, so that is the one that must never be missing
    # while we hold the slot.
    with open(pidfile, "w", encoding="utf-8") as handle:
        handle.write("%d\n" % os.getpid())
    started = iso_now()
    write_status(status_path, started)

    def release(*_args):
        # Only remove if they still name us; another instance may have
        # overwritten them in a race.
        if read_pid(pidfile) == os.getpid():
            remove_quietly(pidfile)
        if status_pid(status_path) == os.getpid():
            remove_quietly(status_path)

    def terminate(*_args):
        release()
        # 143 = 128 + SIGTERM, the shell's convention, which the skills
        # and their tests already expect from the previous bash version.
        os._exit(143)

    def requested_stop(signum, _frame):
        # A stop asked for by another copy of this script, so it gets
        # the clean exit a `watch-stop.json` request gets, not a
        # signalled 143 the agent would read as a crash.
        release()
        print("Stopping: %s" % ("replaced by a new watcher"
                                if signum == TAKEOVER_SIGNAL
                                else "stop requested"), file=sys.stderr)
        sys.stderr.flush()
        # `os._exit`, like `terminate`: the handler can land mid-write
        # of the status temp file, and `release` has already run.
        os._exit(0 if loop else EXIT_STOPPED)

    import atexit
    atexit.register(release)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    signal.signal(STOP_SIGNAL, requested_stop)
    signal.signal(TAKEOVER_SIGNAL, requested_stop)
    return started


def log_mtime(log_path):
    try:
        return os.stat(log_path).st_mtime
    except OSError:
        return None


def catch_up(opts, emitter, log_path, lines):
    """--after replay. Returns True if the caller should stop watching.

    Works from the `lines` the caller already read, rather than reading
    log.json again: a capture landing between the two reads would sit
    behind the poll loop's cursor and never be emitted.

    If the timestamp isn't in the log, warn and fall through to the
    normal poll — the record has most likely aged out of log.json into
    a history file, and watching from now on is still useful.
    """
    if not os.path.isfile(log_path):
        print("Warning: %s not found; ignoring --after and watching as usual"
              % log_path, file=sys.stderr)
        return False

    records = [record for record in map(parse_record, lines)
               if record is not None]
    # A cursor, not a time comparison: emit whatever follows this record
    # in the log. Timestamps aren't ordered strictly enough for `>` to be
    # safe.
    #
    # Scanning backwards costs nothing and degrades well: the extension
    # keeps log.json timestamps unique, but against a log that repeats
    # one, landing on the last record carrying it still advances, where
    # matching the first would replay the rest on every call forever.
    #
    # Matching the parsed `timestamp` field, so a prompt whose text
    # happens to contain the same string can't be mistaken for it.
    index = next((i for i in range(len(records) - 1, -1, -1)
                  if records[i].get("timestamp") == opts.after), None)
    if index is None:
        print("Warning: '%s' not found in %s; ignoring --after and watching"
              " as usual" % (opts.after, log_path), file=sys.stderr)
        return False

    pending = records[index + 1:]
    if not pending:
        return False
    if opts.catch_up_one:
        emitter.emit(pending[0])
        return not opts.loop
    noun = "capture" if len(pending) == 1 else "captures"
    print("%d pending %s:" % (len(pending), noun), file=sys.stderr)
    for record in pending:
        emitter.emit(record)
    return not opts.loop


def lines_after(lines, cursor):
    """The lines following `cursor` in the log, in file order.

    A cursor, not a time comparison — the same rule as `--after`, and
    for the same reason. The whole line is the key rather than the
    `timestamp` field; both are unique, since every record gets its own
    timestamp.

    Scanned backwards so a log that repeats a line (one written before
    timestamps were unique) still advances instead of replaying.

    A cursor that isn't in the log resumes from the newest record. It
    can't have aged out into a history file from under a live watcher —
    log.json holds at least 50 records — so this is a log that was
    rewritten from somewhere else entirely.
    """
    if cursor is None:
        return lines
    for i in range(len(lines) - 1, -1, -1):
        if lines[i] == cursor:
            return lines[i + 1:]
    return lines[-1:]


def watch(opts, emitter, source_dir, log_path):
    # Chrome only creates the source dir on the first download.
    # Watching can legitimately start before that, so create it now (we
    # need somewhere for the pidfile to land and a target to poll).
    try:
        os.makedirs(source_dir, exist_ok=True)
    except OSError:
        die("Error: cannot create watch directory: %s" % source_dir)

    # The stop protocol rides on the pid lock: only a watcher that
    # claimed the slot publishes a status file, and only that watcher
    # answers a stop request.
    status_path = os.path.join(source_dir, STATUS_FILE)
    stop_path = os.path.join(source_dir, STOP_FILE)
    started = (claim_watch_slot(source_dir, opts.loop)
               if opts.pid_lockfile else None)
    last_beat = time.monotonic()

    # Don't emit the current contents on poll-loop entry — only changes
    # from this point. (--get-latest already handled "current".)
    #
    # mtime first, then the contents: a capture landing between the two
    # reads leaves the stale mtime behind, so the next poll picks it up.
    # The other order would record an mtime that already covers it.
    last_mtime = log_mtime(log_path)
    lines = read_lines(log_path)
    cursor = lines[-1] if lines else None

    if opts.after is not None and catch_up(opts, emitter, log_path, lines):
        return

    while True:
        if started is not None:
            if os.path.exists(stop_path):
                # The Capture page's Stop button. Take the request with
                # us; the atexit release deletes the pid and status files.
                # On stderr, not stdout: stdout is the record stream.
                remove_quietly(stop_path)
                print("Stopping: stop requested from the extension",
                      file=sys.stderr)
                # A single-shot run is one iteration of a loop the agent
                # re-runs, so exiting 0 with nothing on stdout would
                # just start the next one.
                if not opts.loop:
                    sys.exit(EXIT_STOPPED)
                return
            now = time.monotonic()
            if now - last_beat >= HEARTBEAT_SECONDS:
                last_beat = now
                write_status(status_path, started)

        current = log_mtime(log_path)
        if current is not None and current != last_mtime:
            last_mtime = current
            # Every line past the cursor, not just the newest one: a
            # burst of captures can land several between two polls, and
            # log.json is rewritten whole each time, so a poll may first
            # see a file that already grew by more than one record.
            lines = read_lines(log_path)
            # An empty log.json (the user emptied it by hand) bumps
            # mtime without producing a new record. Forget the cursor
            # with it: whatever refills the file is all new.
            if not lines:
                cursor = None
            for line in lines_after(lines, cursor):
                record = parse_record(line)
                # Anchor on lines that parse. A line caught mid-rewrite
                # is still handed over, but by the next poll it's
                # complete and no longer matches, and a cursor that
                # can't be found skips everything behind it.
                if record is not None:
                    cursor = line
                emitter.emit(record, raw=line)
                if not opts.loop:
                    return
        time.sleep(POLL_SECONDS)


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


def get_latest(opts, emitter, log_path):
    """Emit the last record in log.json.

    Missing or empty is an error on its own, but fine when combined
    with --watch: there the log not existing yet is the normal case.
    """
    if not os.path.isfile(log_path):
        if not opts.watch:
            die("Error: %s not found. No captures yet?" % log_path)
        return
    line = read_last_line(log_path)
    if line is None:
        if not opts.watch:
            die("Error: %s is empty. No captures yet." % log_path)
        return
    emitter.emit(parse_record(line), raw=line)


def main(argv):
    # Line-buffered rather than the default block buffering on a pipe:
    # --watch --loop is consumed live (Claude Code's Monitor turns each
    # stdout line into its own notification), so a record held in a
    # buffer until exit is a record the agent never sees.
    sys.stdout.reconfigure(line_buffering=True)

    opts = parse_args(argv)
    source_dir = resolve_dir(opts)
    log_path = os.path.join(source_dir, "log.json")
    emitter = Emitter(opts, source_dir)

    if opts.stop:
        if stop_watcher(source_dir):
            print("Stopping existing watcher on %s" % source_dir)
        else:
            print("No existing watcher to stop")

    if opts.get_latest:
        get_latest(opts, emitter, log_path)

    if opts.list:
        list_history(opts, emitter, source_dir, log_path)

    if opts.watch:
        watch(opts, emitter, source_dir, log_path)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:
        # A consumer that stops reading (`| head`) is not an error.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(errno.EPIPE)
