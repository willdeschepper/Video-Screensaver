/**
 * Video Screensaver - GNOME Shell Extension
 *
 * Plays local video files from a folder as a fullscreen screensaver across all
 * monitors after a configurable period of user inactivity.
 *
 * Requires GNOME Shell 47+
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SCHEMA_ID = 'org.gnome.shell.extensions.video-screensaver';

const DEBUG = false;

// D-Bus interface for logind (suspend detection)
const LOGIN_DBUS_NAME = 'org.freedesktop.login1';
const LOGIN_DBUS_PATH = '/org/freedesktop/login1';
const LOGIN_DBUS_IFACE = 'org.freedesktop.login1.Manager';

// Async file APIs, so disk access never blocks the Shell's main thread
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

// ─── Top-bar Indicator ────────────────────────────────────────────────────────

const VideoScreensaverIndicator = GObject.registerClass(
class VideoScreensaverIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Video Screensaver'));
        this._ext = extension;

        // Panel icon
        this._icon = new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._buildMenu();
    }

    _buildMenu() {
        const settings = this._ext._getSettings();

        // ── Enable/disable screensaver toggle ──
        this._enableItem = new PopupMenu.PopupSwitchMenuItem(
            _('Screensaver enabled'),
            settings.get_boolean('enabled')
        );
        this._enableItem.connect('toggled', (_item, state) => {
            settings.set_boolean('enabled', state);
        });
        this.menu.addMenuItem(this._enableItem);

        // ── Lock screen after exit ──
        this._lockItem = new PopupMenu.PopupSwitchMenuItem(
            _('Lock screen after exit'),
            settings.get_boolean('lock-screen-after')
        );
        this._lockItem.connect('toggled', (_item, state) => {
            settings.set_boolean('lock-screen-after', state);
        });
        this.menu.addMenuItem(this._lockItem);

        // ── Mute video ──
        this._muteItem = new PopupMenu.PopupSwitchMenuItem(
            _('Mute video'),
            settings.get_boolean('mute-video')
        );
        this._muteItem.connect('toggled', (_item, state) => {
            settings.set_boolean('mute-video', state);
        });
        this.menu.addMenuItem(this._muteItem);

        // ── Shuffle videos ──
        this._shuffleItem = new PopupMenu.PopupSwitchMenuItem(
            _('Shuffle videos'),
            settings.get_boolean('shuffle-videos')
        );
        this._shuffleItem.connect('toggled', (_item, state) => {
            settings.set_boolean('shuffle-videos', state);
        });
        this.menu.addMenuItem(this._shuffleItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Idle timeout slider (0–30 minutes) ──
        const timeoutLabel = new PopupMenu.PopupMenuItem(
            _('Idle timeout: %d min').format(settings.get_int('idle-timeout-minutes')),
            {reactive: false}
        );
        this.menu.addMenuItem(timeoutLabel);

        const sliderItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._slider = new Slider(settings.get_int('idle-timeout-minutes') / 30);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', slider => {
            const minutes = Math.round(slider.value * 30);
            timeoutLabel.label.text = _('Idle timeout: %d min').format(minutes);

            // Save once the slider stops moving instead of on every pixel
            if (this._saveTimeoutId)
                GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._saveTimeoutId = null;
                if (settings.get_int('idle-timeout-minutes') !== minutes)
                    settings.set_int('idle-timeout-minutes', minutes);
                return GLib.SOURCE_REMOVE;
            });
        });
        sliderItem.add_child(this._slider);
        this.menu.addMenuItem(sliderItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Videos folder label + entry ──
        const folderLabelItem = new PopupMenu.PopupMenuItem(
            _('Videos folder:'),
            {reactive: false}
        );
        this.menu.addMenuItem(folderLabelItem);

        const pathItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._pathEntry = new St.Entry({
            text: settings.get_string('videos-folder'),
            hint_text: _('/path/to/videos/'),
            x_expand: true,
            style_class: 'video-screensaver-path-entry',
        });
        this._pathEntry.clutter_text.connect('activate', entry => {
            settings.set_string('videos-folder', entry.get_text());
        });
        pathItem.add_child(this._pathEntry);
        this.menu.addMenuItem(pathItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Start now button ──
        const startItem = new PopupMenu.PopupMenuItem(_('Start Screensaver Now'));
        startItem.connect('activate', () => {
            this.menu.close();
            this._ext.activateScreensaver();
        });
        this.menu.addMenuItem(startItem);

        // Keep toggle states in sync when settings change externally
        this._settingsChangedId = settings.connect('changed', (s, key) => {
            if (key === 'enabled')
                this._enableItem.setToggleState(s.get_boolean('enabled'));
            else if (key === 'lock-screen-after')
                this._lockItem.setToggleState(s.get_boolean('lock-screen-after'));
            else if (key === 'mute-video')
                this._muteItem.setToggleState(s.get_boolean('mute-video'));
            else if (key === 'shuffle-videos')
                this._shuffleItem.setToggleState(s.get_boolean('shuffle-videos'));
            else if (key === 'videos-folder')
                this._pathEntry.text = s.get_string('videos-folder');
            else if (key === 'idle-timeout-minutes') {
                const m = s.get_int('idle-timeout-minutes');
                timeoutLabel.label.text = _('Idle timeout: %d min').format(m);
                if (this._slider)
                    this._slider.value = m / 30;
            }
        });
    }

    destroy() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
        }
        if (this._settingsChangedId) {
            this._ext._getSettings().disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

// ─── Fullscreen Screensaver Actor ─────────────────────────────────────────────

/**
 * One fullscreen actor per monitor. Covers the entire monitor rectangle
 * and hosts the error message when video fails.
 */
const ScreensaverActor = GObject.registerClass(
class ScreensaverActor extends St.Widget {
    _init(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex];
        super._init({
            style_class: 'video-screensaver-overlay',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            reactive: true,
        });
        this._monitor = monitor;
    }

    showError(message, videoPath) {
        // Remove any previous error display
        this.remove_all_children();

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            text: _('Video Screensaver Error'),
            style_class: 'video-screensaver-error-title',
        });
        box.add_child(title);

        const msg = new St.Label({
            text: message,
            style_class: 'video-screensaver-error-message',
        });
        box.add_child(msg);

        const pathLabel = new St.Label({
            text: _('Path: %s').format(videoPath),
            style_class: 'video-screensaver-error-path',
        });
        box.add_child(pathLabel);

        this.add_child(box);
    }
});

// ─── Main Extension Class ─────────────────────────────────────────────────────

export default class VideoScreensaverExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA_ID);
        this._actors = [];
        this._screensaverActive = false;
        this._playerProc = null;
        this._playerProcs = [];
        this._inputSignals = [];
        this._userActiveWatchId = null;
        this._idleWatchId = null;
        this._idleMonitor = null;
        this._loginProxy = null;
        this._suspendSignalId = null;
        this._settingsChangedId = null;
        this._indicator = null;
        this._locking = false;
        this._cancellable = null;

        this._markerFile = GLib.build_filenamev([
            GLib.get_user_runtime_dir(), 'video-screensaver.pid',
        ]);

        // Build the panel indicator — must succeed before anything else
        this._indicator = new VideoScreensaverIndicator(this);
        Main.panel.addToStatusArea('video-screensaver', this._indicator);

        // Non-critical setup: each step is isolated so a failure here does not
        // prevent the extension from reaching a functional enabled state.
        this._connectLogind();
        this._applyIdleMonitor();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'idle-timeout-minutes' || key === 'enabled')
                this._applyIdleMonitor();
        });

        this._killOrphanedPlayer();
    }

    disable() {
        // ── Remove the panel icon FIRST ──────────────────────────────────────
        // This must happen unconditionally so the icon always disappears,
        // regardless of any error in the cleanup steps that follow.
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // ── Disconnect settings listener ─────────────────────────────────────
        try {
            if (this._settingsChangedId && this._settings) {
                this._settings.disconnect(this._settingsChangedId);
            }
        } catch (e) {
            if (DEBUG) console.warn('[VideoScreensaver] disable: settings disconnect error:', e.message);
        }
        this._settingsChangedId = null;

        // ── Idle monitor ─────────────────────────────────────────────────────
        try {
            this._removeIdleWatch();
        } catch (e) {
            if (DEBUG) console.warn('[VideoScreensaver] disable: idle watch removal error:', e.message);
        }

        // ── Logind proxy ─────────────────────────────────────────────────────
        try {
            this._disconnectLogind();
        } catch (e) {
            if (DEBUG) console.warn('[VideoScreensaver] disable: logind disconnect error:', e.message);
        }

        // ── Screensaver / player ─────────────────────────────────────────────
        try {
            if (this._screensaverActive)
                this._stopScreensaver(false, true);
        } catch (e) {
            if (DEBUG) console.warn('[VideoScreensaver] disable: screensaver stop error:', e.message);
        }

        this._settings = null;
    }

    // ── Settings accessor used by the indicator ──────────────────────────────
    // Named with underscore prefix to avoid shadowing Extension.getSettings()

    _getSettings() {
        return this._settings;
    }

    // ── Idle monitor setup ───────────────────────────────────────────────────

    _applyIdleMonitor() {
        this._removeIdleWatch();

        if (!this._settings.get_boolean('enabled'))
            return;

        const minutes = this._settings.get_int('idle-timeout-minutes');
        if (minutes <= 0)
            return;

        try {
            // get_core_idle_monitor() is the correct API in GNOME 47+
            this._idleMonitor = global.backend.get_core_idle_monitor();
            if (!this._idleMonitor)
                throw new Error('get_core_idle_monitor() returned null');

            const thresholdMs = minutes * 60 * 1000;
            this._idleWatchId = this._idleMonitor.add_idle_watch(thresholdMs, () => {
                if (!this._screensaverActive)
                    this.activateScreensaver();
            });
        } catch (e) {
            console.error('[VideoScreensaver] Failed to set up idle monitor:', e.message);
            this._idleMonitor = null;
            this._idleWatchId = null;
        }
    }

    _removeIdleWatch() {
        if (this._idleWatchId !== null) {
            try {
                global.backend.get_core_idle_monitor().remove_watch(this._idleWatchId);
            } catch (e) {
                // Ignore — monitor may have gone away already
            }
            this._idleWatchId = null;
        }
        this._idleMonitor = null;
    }

    // ── Logind suspend detection ─────────────────────────────────────────────

    _connectLogind() {
        try {
            this._loginProxy = Gio.DBusProxy.new_sync(
                Gio.DBus.system,
                Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                null,
                LOGIN_DBUS_NAME,
                LOGIN_DBUS_PATH,
                LOGIN_DBUS_IFACE,
                null
            );

            this._suspendSignalId = this._loginProxy.connectSignal(
                'PrepareForSleep',
                (_proxy, _sender, [sleeping]) => {
                    if (sleeping && this._screensaverActive)
                        this._stopScreensaver(false, true);
                }
            );
        } catch (e) {
            if (DEBUG) console.warn('[VideoScreensaver] Could not connect to logind:', e.message);
            this._loginProxy = null;
        }
    }

    _disconnectLogind() {
        if (this._loginProxy && this._suspendSignalId) {
            this._loginProxy.disconnectSignal(this._suspendSignalId);
            this._suspendSignalId = null;
        }
        this._loginProxy = null;
    }

    // ── Screensaver lifecycle ────────────────────────────────────────────────

    activateScreensaver() {
        if (this._screensaverActive)
            return;

        // mpv would play hidden behind the lock screen (with audio) all night
        if (Main.sessionMode.isLocked)
            return;

        this._screensaverActive = true;

        // NOTE: We do NOT create black overlay actors here.
        // GNOME Shell's uiGroup sits above all application windows in the
        // compositor Z-order. Adding an opaque actor here would permanently
        // cover the mpv window, leaving only a black screen.
        //
        // Overlay actors are created lazily in _showError() if mpv fails to
        // launch, so the user always sees a meaningful error message.

        this._cancellable = new Gio.Cancellable();
        this._startPlayer(this._cancellable).catch(e => {
            console.error('[VideoScreensaver] Failed to start player:', e.message);
        });
        this._connectInputSignals();
    }

    _stopScreensaver(lockScreen = false, killPlayer = true) {
        if (!this._screensaverActive && this._actors.length === 0)
            return;

        this._screensaverActive = false;

        // Abort a folder listing that may still be running
        this._cancellable?.cancel();
        this._cancellable = null;

        this._disconnectInputSignals();

        if (killPlayer)
            this._stopPlayer();

        // Remove all overlay actors
        for (const actor of this._actors) {
            Main.uiGroup.remove_child(actor);
            actor.destroy();
        }
        this._actors = [];

        if (lockScreen && this._settings?.get_boolean('lock-screen-after'))
            this._lockScreen();
    }

    // ── Player management ────────────────────────────────────────────────────

    /**
     * List the videos folder asynchronously and launch mpv. A slow or hung
     * disk/network folder never freezes the Shell; if the screensaver is
     * dismissed meanwhile, `cancellable` aborts the listing.
     *
     * @param {Gio.Cancellable} cancellable
     */
    async _startPlayer(cancellable) {
        const folderPath = this._settings.get_string('videos-folder');

        if (!folderPath || folderPath.trim() === '') {
            this._showError(_('No videos folder configured.'), folderPath ?? '');
            return;
        }

        let videoFiles;
        try {
            videoFiles = await this._listVideoFiles(folderPath, cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY)) {
                this._showError(_('Videos folder not found.'), folderPath);
                return;
            }
            console.error('[VideoScreensaver] Error listing videos folder:', e.message);
            videoFiles = [];
        }

        // Dismissed (or extension disabled) while the folder was being listed
        if (cancellable.is_cancelled())
            return;

        if (videoFiles.length === 0) {
            this._showError(_('No video files found in folder.'), folderPath);
            return;
        }

        this._launchMpv(videoFiles, folderPath);
    }

    /**
     * Enumerate all video files inside folderPath and return their absolute
     * paths sorted alphabetically. Supported extensions: mp4, mkv, webm, avi,
     * mov, m4v.
     *
     * @param {string} folderPath
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<string[]>}
     */
    async _listVideoFiles(folderPath, cancellable) {
        const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
        const dir = Gio.File.new_for_path(folderPath);
        const files = [];

        const enumerator = await dir.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );

        try {
            let infos;
            while ((infos = await enumerator.next_files_async(
                50, GLib.PRIORITY_DEFAULT, cancellable)).length > 0) {
                for (const fileInfo of infos) {
                    if (fileInfo.get_file_type() !== Gio.FileType.REGULAR)
                        continue;
                    const name = fileInfo.get_name();
                    const lower = name.toLowerCase();
                    if (VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext)))
                        files.push(GLib.build_filenamev([folderPath, name]));
                }
            }
        } finally {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }

        files.sort();
        return files;
    }

    /**
     * Launch one mpv instance per monitor in fullscreen playlist mode.
     *
     * We do NOT create GNOME Shell overlay actors here; mpv renders its own
     * window which the Wayland/X11 compositor places below the Shell UI layer.
     * --ontop and --fs ensure mpv sits above normal application windows but
     * the Shell's top-bar and notifications remain accessible for input capture.
     *
     * Multi-monitor: one mpv process is spawned per display using --screen=N.
     * On Wayland this may fall back to the primary display depending on the
     * compositor; on X11 it works reliably.
     *
     * @param {string[]} videoPaths - Ordered list of absolute video file paths.
     * @param {string}   folderPath - Source folder (used in error messages).
     */
    _launchMpv(videoPaths, folderPath) {
        const mute = this._settings.get_boolean('mute-video');
        const shuffle = this._settings.get_boolean('shuffle-videos');
        const monitorCount = Main.layoutManager.monitors.length;
        this._playerProcs = [];

        for (let screenIdx = 0; screenIdx < monitorCount; screenIdx++) {
            const argv = [
                'mpv',
                '--fs',
                `--screen=${screenIdx}`,
                `--fs-screen=${screenIdx}`,
                // Loop the entire playlist indefinitely
                '--loop-playlist=inf',
                '--no-terminal',
                '--really-quiet',
                '--no-border',
                '--ontop',
                '--hwdec=auto',
                // Disable all mpv keyboard/mouse bindings so keys like ESC and
                // 'q' never exit fullscreen on their own. Dismissal is handled
                // exclusively by the Shell's idle-monitor user-active watch.
                '--no-input-default-bindings',
                '--input-conf=/dev/null',
                mute ? '--mute=yes' : '--mute=no',
                // Silence audio on duplicate screens (only first plays audio)
                ...(screenIdx > 0 ? ['--mute=yes'] : []),
                // Randomise playback order when the user enabled shuffle
                ...(shuffle ? ['--shuffle'] : []),
                // Fill-screen / background of the bars around the video
                ...this._displayArgs(Main.layoutManager.monitors[screenIdx]),
                // Separator before positional file arguments
                '--',
                ...videoPaths,
            ];

            try {
                const proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.NONE,
                });
                proc.init(null);
                this._playerProcs.push(proc);

                // Watch for unexpected exit of each process
                proc.wait_async(null, (_p, result) => {
                    try { _p.wait_finish(result); } catch (_e) { /* gone */ }

                    this._playerProcs = (this._playerProcs ?? []).filter(p => p !== proc);
                    if (this._playerProcs.length === 0)
                        this._clearMarkerFile();

                    // All processes exited while still active → show error
                    if (this._screensaverActive &&
                        (this._playerProcs ?? []).length === 0) {
                        this._showError(
                            _('Player process exited unexpectedly.'),
                            folderPath
                        );
                    }
                });
            } catch (e) {
                this._writeMarkerFile();
                this._showError(
                    _('Failed to launch mpv: %s').format(e.message),
                    folderPath
                );
                return;
            }
        }

        this._writeMarkerFile();
    }

    /**
     * mpv arguments for the fill-screen and background settings.
     *
     * @param {object} monitor - Monitor geometry (used for its aspect ratio).
     * @returns {string[]}
     */
    _displayArgs(monitor) {
        // Zoom until the video covers the screen, cropping what overflows
        if (this._settings.get_boolean('fill-screen'))
            return ['--panscan=1.0'];

        switch (this._settings.get_string('background-mode')) {
        case 'blur':
            return ['--border-background=blur'];
        case 'edge':
            return [
                // Software filters need frames copied back from the GPU
                '--hwdec=auto-copy',
                `--script=${GLib.build_filenamev([this.path, 'edge-fill.lua'])}`,
                `--script-opts=edge_fill-aspect=${monitor.width / monitor.height}`,
            ];
        default: {
            const color = this._settings.get_string('background-color');
            // Black is mpv's default: keep the original command line
            if (color.toLowerCase() === '#000000')
                return [];
            return ['--border-background=color', `--background-color=${color}`];
        }
        }
    }

    _stopPlayer() {
        for (const proc of (this._playerProcs ?? [])) {
            try { proc.force_exit(); } catch (_e) { /* already dead */ }
        }
        this._playerProcs = [];
        // Legacy single-proc field (kept for safety)
        if (this._playerProc) {
            try { this._playerProc.force_exit(); } catch (_e) { /* ignore */ }
            this._playerProc = null;
        }
        this._clearMarkerFile();
    }

    /**
     * Store the PIDs of all running mpv processes (one per line) so a later
     * extension instance can clean them up after a crash or reload.
     */
    _writeMarkerFile() {
        const pids = (this._playerProcs ?? [])
            .map(p => p.get_identifier())
            .filter(pid => pid);
        if (pids.length === 0)
            return;

        Gio.File.new_for_path(this._markerFile).replace_contents_async(
            new TextEncoder().encode(pids.join('\n')),
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (_f, res) => {
                try { _f.replace_contents_finish(res); } catch (_e) { /* ignore */ }
            }
        );
    }

    /** Kill any orphaned mpv left over from a previous extension instance. */
    _killOrphanedPlayer() {
        const file = Gio.File.new_for_path(this._markerFile);
        file.load_contents_async(null, (_f, res) => {
            let pids = [];
            try {
                const [, contents] = _f.load_contents_finish(res);
                pids = new TextDecoder().decode(contents)
                    .split('\n')
                    .map(line => parseInt(line, 10))
                    .filter(pid => pid > 0);
            } catch (_e) { /* no marker: nothing to clean up */ }

            for (const pid of pids)
                this._killIfMpv(pid);

            this._clearMarkerFile();
        });
    }

    /**
     * Send SIGTERM to pid only if it is still an mpv process. PIDs get reused,
     * so a stale marker must never kill an unrelated program.
     *
     * @param {number} pid
     */
    _killIfMpv(pid) {
        const comm = Gio.File.new_for_path(`/proc/${pid}/comm`);
        comm.load_contents_async(null, (_f, res) => {
            try {
                const [, contents] = _f.load_contents_finish(res);
                if (new TextDecoder().decode(contents).trim() !== 'mpv')
                    return;
                GLib.spawn_async(null, ['kill', String(pid)], null,
                    GLib.SpawnFlags.SEARCH_PATH, null);
            } catch (_e) { /* process already gone */ }
        });
    }

    _clearMarkerFile() {
        try {
            if (GLib.file_test(this._markerFile, GLib.FileTest.EXISTS))
                Gio.File.new_for_path(this._markerFile).delete(null);
        } catch (_e) { /* ignore */ }
    }

    // ── Error display ────────────────────────────────────────────────────────

    _showError(message, videoPath) {
        console.error('[VideoScreensaver]', message, videoPath);

        // Create fullscreen error overlay actors on demand (only on failure).
        // We avoid creating them upfront so they never cover a running mpv window.
        if (this._actors.length === 0) {
            const monitors = Main.layoutManager.monitors;
            for (let i = 0; i < monitors.length; i++) {
                const actor = new ScreensaverActor(i);
                Main.uiGroup.add_child(actor);
                Main.uiGroup.set_child_above_sibling(actor, null);
                this._actors.push(actor);
            }
        }

        for (const actor of this._actors)
            actor.showError(message, videoPath);
    }

    // ── Input detection ──────────────────────────────────────────────────────

    _connectInputSignals() {
        // add_user_active_watch() fires on the next compositor-level input
        // event (mouse, keyboard, touch) regardless of which window has focus.
        // This works reliably on Wayland even when mpv owns the keyboard,
        // unlike global.stage 'captured-event' which mpv can intercept first.
        // It is a one-shot watch: fires once then is automatically removed.
        try {
            this._userActiveWatchId =
                global.backend.get_core_idle_monitor().add_user_active_watch(() => {
                    this._userActiveWatchId = null;
                    this._stopScreensaver(/* lockScreen= */ true, /* killPlayer= */ true);
                });
        } catch (e) {
            console.warn('[VideoScreensaver] user_active_watch failed, falling back to stage:', e.message);
            this._connectStageFallback();
        }
    }

    /** Fallback for compositors where add_user_active_watch is unavailable. */
    _connectStageFallback() {
        const dismiss = () => this._stopScreensaver(true, true);
        this._inputSignals.push(
            global.stage.connect('captured-event', (_actor, event) => {
                const type = event.type();
                if (
                    type === Clutter.EventType.MOTION ||
                    type === Clutter.EventType.BUTTON_PRESS ||
                    type === Clutter.EventType.KEY_PRESS ||
                    type === Clutter.EventType.TOUCH_BEGIN
                ) {
                    dismiss();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            })
        );
    }

    _disconnectInputSignals() {
        // Remove the idle-monitor user-active watch if it is still pending
        if (this._userActiveWatchId !== null) {
            try {
                global.backend.get_core_idle_monitor()
                    .remove_watch(this._userActiveWatchId);
            } catch (_e) { /* already fired or monitor gone */ }
            this._userActiveWatchId = null;
        }

        // Remove any stage fallback signals
        for (const id of this._inputSignals)
            global.stage.disconnect(id);
        this._inputSignals = [];
    }

    // ── Screen lock ──────────────────────────────────────────────────────────

    _lockScreen() {
        // Guard against re-entrant calls triggered by Clutter events
        // fired during the lock animation.
        if (this._locking)
            return;
        this._locking = true;
        try {
            if (Main.screenShield)
                Main.screenShield.lock(false);
        } catch (e) {
            console.warn('[VideoScreensaver] Could not lock screen:', e.message);
        } finally {
            this._locking = false;
        }
    }
}
