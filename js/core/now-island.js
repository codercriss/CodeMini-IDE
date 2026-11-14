// ==========================================
// now-island.js
// ==========================================

(function initNowIsland() {
    // 1. Inject Styles for Now Island
    const style = document.createElement('style');
    style.innerHTML = `
        #nowIslandPanel {
            position: fixed;
            bottom: 30px; /* Above PC status bar (26px) + margin */
            right: 15px;
            width: 370px;
            /* Grows with its content (a running task, a long list) but never past 72vh; 290px when there is little to show. */
            height: auto;
            min-height: 290px;
            max-height: 72vh;
            background-color: var(--bg-white);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            box-shadow: 0 4px 20px var(--shadow-color);
            display: flex;
            flex-direction: column;
            z-index: 9999;
            transform: translateY(15px);
            opacity: 0;
            visibility: hidden;
            transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        
        #nowIslandPanel.show {
            transform: translateY(0);
            opacity: 1;
            visibility: visible;
        }
        
        .ni-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 15px;
            background-color: var(--bg-white);
            border-radius: 6px 6px 0 0;
        }
        
        .ni-title {
            font-weight: 600;
            font-size: 13px;
            color: var(--text-main);
        }
        
        .ni-controls {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .ni-tabs {
            display: flex;
            gap: 12px;
        }
        
        .ni-tab {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            cursor: pointer;
            transition: color 0.2s;
        }
        
        
        .ni-tab.active {
            color: var(--accent-blue);
            font-weight: 700;
        }
        
        #nowIslandClose {
            cursor: pointer;
            font-size: 16px;
            color: var(--icon-gray);
            transition: color 0.2s;
        }
        
        #nowIslandClose:hover {
            color: var(--color-danger);
        }
        
        .ni-body {
            flex: 1;
            min-height: 0;
            position: relative;
            display: flex;
            flex-direction: column;
            background-color: var(--bg-white);
            border-radius: 0 0 6px 6px;
        }

        /* A pane is a flex column so that it fills a panel that is at its minimum height (the empty states centre in it),
           and scrolls inside the body once the panel has reached max-height. */
        .ni-pane {
            display: none;
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
        }

        .ni-pane.active {
            display: flex;
            flex-direction: column;
        }

        .ni-pane.active > *:not(.ni-empty) {
            flex: none;
        }

        .ni-badge {
            display: inline-block;
            min-width: 14px;
            padding: 0 4px;
            margin-left: 4px;
            border-radius: 8px;
            background-color: var(--accent-new, #00897b);
            color: var(--text-on-accent, #fff);
            font-size: 10px;
            line-height: 14px;
            text-align: center;
            vertical-align: 1px;
        }

        .ni-badge[hidden] {
            display: none;
        }

        /* Status-bar button: the unread count, as plain text (no background) right after the icon.
           It is a flex item of .status-item, so it is vertically centred with the icon and never
           overlaps it. The number comes from the data-unread attribute set in render(). */
        #nowIsland.has-unread::after {
            content: attr(data-unread);
            color: var(--accent-new, #00897b);
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            font-variant-numeric: tabular-nums;
        }

        .ni-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            flex: 1 0 auto;
            min-height: 120px;
            color: var(--text-muted);
            font-size: 12px;
        }

        .ni-empty[hidden],
        .ni-sec[hidden],
        #niPeekDock[hidden] {
            display: none;
        }

        .ni-empty i {
            font-size: 26px;
            opacity: 0.6;
        }

        /* ---- Notification item: white background, dashed bottom border ---- */
        .ni-notif-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }

        .ni-notif {
            background-color: var(--bg-white);
            border-bottom: 1px dashed var(--border-color);
            padding: 10px 15px;
            cursor: pointer;
        }

        .ni-notif:focus-visible {
            outline: 1px solid var(--accent-blue);
            outline-offset: -1px;
        }

        .ni-notif-top {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .ni-notif-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-main);
        }

        .ni-notif.unread .ni-notif-title {
            font-weight: 700;
        }

        .ni-notif.unread .ni-notif-title::before {
            content: '';
            display: inline-block;
            width: 7px;
            height: 7px;
            margin-right: 7px;
            border-radius: 50%;
            background-color: var(--accent-new, #00897b);
            vertical-align: 1px;
        }

        .ni-notif-actions {
            display: flex;
            align-items: center;
            gap: 12px;
            flex: none;
        }

        .ni-icon-btn {
            display: inline-flex;
            align-items: center;
            padding: 0;
            border: 0;
            background: none;
            font: inherit;
            font-size: 15px;
            color: var(--icon-gray);
            cursor: pointer;
            transition: color 0.2s;
        }

        .ni-icon-btn:hover,
        .ni-icon-btn:focus-visible {
            color: var(--accent-blue);
        }

        .ni-icon-btn.danger:hover,
        .ni-icon-btn.danger:focus-visible {
            color: var(--color-danger);
        }

        .ni-notif-text {
            margin-top: 4px;
            font-size: 12px;
            line-height: 1.45;
            color: var(--text-muted);
            overflow: hidden;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            line-clamp: 2;
        }

        /* ---- Notification viewer: covers the whole island ---- */
        .ni-viewer {
            position: absolute;
            inset: 0;
            z-index: 2;
            display: none;
            flex-direction: column;
            background-color: var(--bg-white);
            /* Follows the panel's corners, so a theme pack that rounds #nowIslandPanel rounds this too. */
            border-radius: inherit;
            overflow: hidden;
        }

        .ni-viewer.show {
            display: flex;
        }

        .ni-viewer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 10px 15px;
        }

        .ni-viewer-left {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
            min-width: 0;
        }

        .ni-viewer-back {
            font-size: 18px;
            flex: none;
        }

        .ni-viewer-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-main);
        }

        .ni-viewer-content {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 12px 15px 15px;
            font-size: 13px;
            line-height: 1.55;
            color: var(--text-main);
        }

        .ni-viewer-time {
            margin-bottom: 8px;
            font-size: 11px;
            color: var(--text-muted);
        }

        .ni-viewer-text {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .ni-viewer-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 14px;
        }

        .ni-btn {
            cursor: pointer;
            border: 1px solid var(--border-color);
            border-radius: 3px;
            background: var(--bg-panel);
            color: var(--text-main);
            font: inherit;
            font-size: 12px;
            padding: 5px 12px;
        }

        .ni-btn.primary {
            background: var(--accent-blue);
            border-color: var(--accent-blue);
            color: var(--text-on-accent, #fff);
        }

        /* ---- Notification toast: appears where the app's other toasts appear when a notification arrives
           while Now Island is closed. Own names (#notifToastStack, .nt-*) so it never shares rules with
           .toast-container / .custom-toast. --nt-offset lifts it above any visible app toast. ---- */
        #notifToastStack {
            position: fixed;
            bottom: calc(35px + var(--nt-offset, 0px));
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        }

        .nt-toast {
            pointer-events: auto;
            cursor: pointer;
            box-sizing: border-box;
            width: 360px;
            max-width: calc(100vw - 40px);
            padding: 10px 14px 12px;
            background-color: var(--bg-white, #ffffff);
            border: 1px solid var(--border-color, #cccccc);
            border-radius: 3px;
            box-shadow: 0 4px 12px var(--shadow-color, rgba(0, 0, 0, 0.15));
            color: var(--text-main, #333333);
            font-family: var(--font-main, sans-serif);
            text-align: left;
            animation: ntFadeIn 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        }

        .nt-toast:focus-visible {
            outline: 1px solid var(--accent-blue);
            outline-offset: -1px;
        }

        .nt-toast.fade-out {
            animation: ntFadeOut 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        }

        .nt-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }

        .nt-source {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted, #666666);
        }

        .nt-close {
            flex: none;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: -4px -6px -4px 0;
            padding: 4px;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 16px;
            color: var(--text-muted, #666666);
            transition: color 0.2s ease;
        }

        .nt-close:hover {
            color: var(--text-main, #333333);
        }

        .nt-title {
            margin-top: 4px;
            font-size: 13px;
            font-weight: 600;
            line-height: 1.35;
            color: var(--text-main, #333333);
            overflow: hidden;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            line-clamp: 2;
            overflow-wrap: anywhere;
        }

        .nt-text {
            margin-top: 2px;
            font-size: 12px;
            color: var(--text-muted, #666666);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        @keyframes ntFadeIn {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes ntFadeOut {
            from { opacity: 1; transform: translateY(0); }
            to { opacity: 0; transform: translateY(12px); }
        }


        /* ---- Background tasks: RUNNING and RECENTLY FINISHED in the Now pane (flat rows, no cards) ---- */
        .ni-sec-running > .sb-section-header {
            position: sticky;
            top: 0;
            z-index: 1;
            background-color: var(--bg-white);
        }

        .ni-task-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }

        .ni-task {
            position: relative;
            background-color: var(--bg-white);
            border-bottom: 1px dashed var(--border-color);
            padding: 10px 15px;
        }

        .ni-task:hover {
            background-color: var(--bg-panel);
        }

        /* While it runs, the 2px progress line replaces the dashed border. */
        .ni-task[data-state="running"] {
            border-bottom-color: transparent;
        }

        .ni-task-top {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .ni-task-icon {
            flex: none;
            font-size: 16px;
            color: var(--icon-gray);
        }

        .ni-task[data-state="success"] .ni-task-icon { color: var(--accent-new, #00897b); }
        .ni-task[data-state="error"] .ni-task-icon { color: var(--color-danger); }
        .ni-task[data-state="stopped"] .ni-task-icon { color: var(--text-muted); }

        .ni-task-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-main);
        }

        .ni-task-actions {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: none;
        }

        .ni-link {
            padding: 0;
            border: 0;
            background: none;
            font: inherit;
            font-size: 12px;
            font-weight: 600;
            color: var(--accent-blue);
            cursor: pointer;
        }

        .ni-link:hover,
        .ni-link:focus-visible {
            text-decoration: underline;
        }

        .ni-link:disabled {
            color: var(--text-muted);
            cursor: default;
            text-decoration: none;
        }

        .ni-task-sub {
            margin: 3px 0 0 24px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            color: var(--text-muted);
        }

        .ni-task[data-state="error"] .ni-task-sub {
            color: var(--color-danger);
        }

        .ni-task-bar {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 2px;
            overflow: hidden;
        }

        .ni-task-bar > span {
            display: block;
            width: 0;
            height: 100%;
            background-color: var(--accent-blue);
            transition: width 0.3s ease;
        }

        .ni-task-bar.indeterminate > span {
            width: 35%;
            animation: niShimmer 1.2s ease-in-out infinite;
        }

        @keyframes niShimmer {
            from { transform: translateX(-100%); }
            to { transform: translateX(300%); }
        }

        @keyframes niSpin {
            to { transform: rotate(360deg); }
        }

        /* Peek: opens under its row, inline, so nothing covers the page and nothing takes focus. */
        .ni-peek {
            margin: 8px 0 2px 24px;
        }

        .ni-peek-meta {
            margin-bottom: 6px;
            font-size: 11px;
            color: var(--text-muted);
            overflow-wrap: anywhere;
        }

        .ni-peek-log,
        .ni-pp-body,
        .ni-log-full {
            background-color: var(--bg-panel);
            font-family: var(--font-mono);
            font-size: 11px;
            line-height: 1.45;
            color: var(--text-main);
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .ni-peek-log {
            padding: 6px 8px;
            max-height: 7.4em;
            overflow: hidden;
        }

        .ni-peek-line.err { color: var(--color-danger); }
        .ni-peek-empty { color: var(--text-muted); font-style: italic; }

        .ni-peek-actions {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-top: 8px;
        }

        .ni-peek-actions .ni-icon-btn {
            margin-left: auto;
        }

        .ni-icon-btn[aria-pressed="true"] {
            color: var(--accent-blue);
        }

        .ni-log-full {
            margin: 10px 0 0;
            padding: 8px 10px;
        }

        .ni-log-full .err { color: var(--color-danger); }

        /* ---- Floating Peek panel: a pinned task stays on screen after the island closes ---- */
        #niPeekDock {
            position: fixed;
            right: 15px;
            bottom: 32px;
            width: 320px;
            max-width: calc(100vw - 20px);
            z-index: 9998; /* below the island (9999), above the editor, below modals */
            display: flex;
            flex-direction: column;
            gap: 8px;
            pointer-events: none; /* only the panels take clicks: everything around them passes through */
        }

        #niPeekDock.dragged {
            right: auto;
            bottom: auto;
        }

        .ni-pp {
            pointer-events: auto;
            display: flex;
            flex-direction: column;
            max-height: 180px;
            overflow: hidden;
            background-color: var(--bg-white);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            box-shadow: 0 4px 20px var(--shadow-color);
            color: var(--text-main);
            animation: ntFadeIn 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        }

        .ni-pp.fade-out {
            animation: ntFadeOut 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        }

        .ni-pp-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 10px;
            cursor: grab;
            user-select: none;
            -webkit-user-select: none;
        }

        .ni-pp-icon { flex: none; font-size: 16px; color: var(--icon-gray); }
        .ni-pp[data-state="success"] .ni-pp-icon { color: var(--accent-new, #00897b); }
        .ni-pp[data-state="error"] .ni-pp-icon { color: var(--color-danger); }

        .ni-pp-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 12px;
            font-weight: 600;
        }

        .ni-pp-time {
            flex: none;
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            color: var(--text-muted);
        }

        .ni-pp-body {
            flex: 1 1 auto;
            min-height: 0;
            padding: 6px 10px;
            max-height: 7.4em;
            overflow: hidden;
        }

        .ni-pp-foot {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 6px 10px;
            border-top: 1px solid var(--border-color);
            font-size: 11px;
            color: var(--text-muted);
        }

        .ni-pp-foot .ni-pp-note {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .ni-pp[data-state="error"] .ni-pp-note { color: var(--color-danger); }

        .ni-pp.collapsed .ni-pp-body,
        .ni-pp.collapsed .ni-pp-foot {
            display: none;
        }

        .ni-pp-more {
            pointer-events: auto;
            align-self: flex-end;
            padding: 2px 8px;
            border: 1px solid var(--border-color);
            border-radius: 10px;
            background-color: var(--bg-white);
            font: inherit;
            font-size: 11px;
            font-weight: 600;
            color: var(--accent-blue);
            cursor: pointer;
        }

        /* ---- Status-bar button: a spinner and the running count in place of the icon, then a brief check or cross ---- */
        #nowIsland .ni-run {
            display: none;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            font-variant-numeric: tabular-nums;
            color: var(--accent-blue);
        }

        #nowIsland.has-running .ni-run,
        #nowIsland.ni-flash .ni-run {
            display: inline-flex;
        }

        #nowIsland.has-running > i:first-child,
        #nowIsland.ni-flash > i:first-child {
            display: none;
        }

        .ni-run-ring {
            width: 12px;
            height: 12px;
            box-sizing: border-box;
            border: 2px solid var(--accent-blue);
            border-right-color: transparent;
            border-radius: 50%;
            animation: niSpin 0.8s linear infinite;
        }

        .ni-run-ring.flash {
            width: auto;
            height: auto;
            border: 0;
            border-radius: 0;
            animation: none;
            font-size: 14px;
            line-height: 1;
        }

        .ni-run-ring.flash.ok { color: var(--accent-new, #00897b); }
        .ni-run-ring.flash.bad { color: var(--color-danger); }
        .ni-run-count:empty { display: none; }

        /* A window that is not the active one and has something running. */
        .window-tab.has-running::after {
            content: '';
            flex: none;
            width: 9px;
            height: 9px;
            box-sizing: border-box;
            border: 2px solid var(--accent-blue);
            border-right-color: transparent;
            border-radius: 50%;
            animation: niSpin 0.8s linear infinite;
        }

        @media (prefers-reduced-motion: reduce) {
            .ni-task-bar.indeterminate > span { animation: none; width: 100%; opacity: 0.45; }
            .ni-run-ring,
            .window-tab.has-running::after { animation: none; }
            .ni-pp, .ni-pp.fade-out { animation: none; }
            .ni-task-bar > span { transition: none; }
        }

        /* Mobile Adaptations */
        @media (max-width: 768px) {
            /* Same spot as the app's own mobile toast: full width, above the status bar */
            #notifToastStack {
                left: 16px;
                right: 16px;
                bottom: calc(56px + var(--nt-offset, 0px));
            }

            .nt-toast {
                width: 100%;
                max-width: 100%;
            }

            #nowIslandPanel {
                bottom: 55px; /* Above mobile status bar (46px) + margin */
                right: 10px;
                /* Adapts to account for the 45px activity bar */
                left: 55px; 
                width: auto;
                height: auto;
                min-height: 340px; /* the app's existing phone height is the minimum; it grows (to 60vh) only when there is content */
                max-height: 60vh;
            }

            /* Pinned Peek panels become a strip above the status bar, beside the activity bar, like the island itself. */
            #niPeekDock {
                left: 55px;
                right: 10px;
                bottom: 55px;
                width: auto;
                max-width: none;
            }

            body.hide-activity-bar #niPeekDock {
                left: 10px;
            }

            html.is-android #niPeekDock {
                bottom: 35px;
            }
            
            /* Dynamically adapts width if the layout hides the activity bar */
            body.hide-activity-bar #nowIslandPanel {
                left: 10px; 
            }

            /* Native Android Override (Accounts for default 26px status bar vs iOS safe areas) */
            html.is-android #nowIslandPanel {
                bottom: 35px;
            }
        }
    `;
    document.head.appendChild(style);

    // 2. Inject HTML Structure
    const panel = document.createElement('div');
    panel.id = 'nowIslandPanel';
    panel.innerHTML = `
        <div class="ni-header">
            <div class="ni-title">Now Island</div>
            <div class="ni-controls">
                <div class="ni-tabs">
                    <span class="ni-tab active" data-pane="now">Now</span>
                    <span class="ni-tab" data-pane="notifications">Notifications<span class="ni-badge" id="niUnreadBadge" hidden>0</span></span>
                </div>
                <i class="ri-layout-grid-fill" id=""></i>
                <i class="ri-close-line" id="nowIslandClose"></i>
            </div>
        </div>
        <div class="ni-body">
            <div class="ni-pane active" data-pane="now"></div>
            <div class="ni-pane" data-pane="notifications"></div>
        </div>
        <div class="ni-viewer" id="niViewer" role="dialog" aria-label="Notification"></div>
    `;
    document.body.appendChild(panel);

    // 3. Notification center (store + list + full-screen viewer)
    const NOTIF_KEY = 'codemini_notifications'; // app-wide: an update, for example, concerns every window
    const NOTIF_MAX = 50;
    const SESSION = Math.random().toString(36).slice(2); // tells this page load apart from earlier ones
    const nowIslandBtn = document.getElementById('nowIsland');
    const closeBtn = document.getElementById('nowIslandClose');
    const tabs = panel.querySelectorAll('.ni-tab');
    const panes = panel.querySelectorAll('.ni-pane');
    const notifPane = panel.querySelector('.ni-pane[data-pane="notifications"]');
    const viewer = panel.querySelector('#niViewer');
    const badge = panel.querySelector('#niUnreadBadge');
    const listeners = new Set();
    let openViewerId = null;
    let viewerTask = null; // id of the background task whose full output the viewer shows (the viewer serves notifications and task output)

    function loadNotifications() {
        try {
            const raw = JSON.parse(localStorage.getItem(NOTIF_KEY));
            if (!Array.isArray(raw)) return [];
            return raw.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string').slice(0, NOTIF_MAX);
        } catch (e) { return []; }
    }
    let items = loadNotifications();

    // An update notification still waiting for a reload when a NEW page load starts has been acted on: the
    // reload happened, so "Reload to use the latest version" would now be wrong.
    items.forEach(n => {
        if (n.kind === 'update' && n.pending && n.session !== SESSION) {
            const v = window.APP_INFO && window.APP_INFO.version;
            n.pending = false;
            n.title = 'Update applied';
            n.text = 'CodeMini IDE was updated and reloaded' + (v ? '. You are now running v' + v + '.' : '.');
        }
    });

    function unreadCount() { return items.filter(n => !n.read).length; }

    function commit() {
        try { localStorage.setItem(NOTIF_KEY, JSON.stringify(items.slice(0, NOTIF_MAX))); } catch (e) { /* storage full or blocked: keep working in memory */ }
        render();
        listeners.forEach(fn => { try { fn(items.slice()); } catch (e) { /* a bad listener must not break the rest */ } });
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function iconButton(iconClass, label, extraClass, onClick) {
        const btn = el('button', 'ni-icon-btn' + (extraClass ? ' ' + extraClass : ''));
        btn.type = 'button';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.appendChild(el('i', iconClass));
        // stopPropagation matters twice over: the click must not also open the item, and it must not reach the
        // document-level "click outside closes the island" handler (the button may already be gone by then, which
        // would make the click look like it came from outside the panel).
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return btn;
    }

    function render() {
        const unread = unreadCount();
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.hidden = unread === 0;
        if (nowIslandBtn) {
            nowIslandBtn.classList.toggle('has-unread', unread > 0);
            if (unread > 0) nowIslandBtn.dataset.unread = badge.textContent; // same text as the tab badge (99+ cap)
            else delete nowIslandBtn.dataset.unread;
            updateButtonLabel();
        }

        notifPane.textContent = '';
        if (!items.length) {
            const empty = el('div', 'ni-empty');
            empty.append(el('i', 'ri-notification-off-line'), el('span', null, 'No notifications'));
            notifPane.appendChild(empty);
        } else {
            const list = el('ul', 'ni-notif-list');
            items.forEach(n => {
                const li = el('li', 'ni-notif' + (n.read ? '' : ' unread'));
                li.tabIndex = 0;
                li.dataset.id = n.id;

                const top = el('div', 'ni-notif-top');
                const title = el('div', 'ni-notif-title', n.title);
                title.title = n.title;
                const actions = el('div', 'ni-notif-actions');
                if (!n.read) actions.appendChild(iconButton('ri-check-double-line', 'Mark as read', '', () => markRead(n.id)));
                actions.appendChild(iconButton('ri-delete-bin-line', 'Delete', 'danger', () => remove(n.id)));
                top.append(title, actions);

                li.append(top, el('div', 'ni-notif-text', n.text || ''));
                li.addEventListener('click', (e) => { e.stopPropagation(); showViewer(n.id); });
                li.addEventListener('keydown', (e) => {
                    if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showViewer(n.id); }
                });
                list.appendChild(li);
            });
            notifPane.appendChild(list);
        }
        if (openViewerId) renderViewer(); // keeps an open viewer in step (text change, deletion elsewhere)
    }

    function add(input) {
        const n = {
            id: (input && input.id) || ('n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
            title: String((input && input.title) || 'Notification'),
            text: String((input && input.text) || ''),
            kind: input && input.kind ? String(input.kind) : 'info',
            source: String((input && input.source) || 'CodeMini'), // who it is from, shown on the toast
            actions: Array.isArray(input && input.actions) ? input.actions.filter(a => typeof a === 'string') : [],
            pending: !!(input && input.pending),
            session: SESSION,
            time: Date.now(),
            read: false
        };
        items = [n].concat(items.filter(x => x.id !== n.id)); // same id replaces: one live "update" notification at a time
        commit();
        // A toast only when the island is closed (when it is open the new item is already in front of the user)
        // and the sender did not opt out (the update notice already has its own toast in pwa.js).
        if (!(input && input.toast === false) && !panel.classList.contains('show')) showToast(n);
        return n.id;
    }

    function markRead(id) {
        const n = items.find(x => x.id === id);
        if (!n || n.read) return;
        n.read = true;
        dismissToast(id);
        commit();
    }

    function remove(id) {
        const had = items.length;
        items = items.filter(x => x.id !== id);
        if (items.length === had) return;
        if (openViewerId === id) hideViewer();
        dismissToast(id);
        commit();
    }

    // ---- notification toast ----
    const TOAST_MS = 6000;       // on screen
    const TOAST_RESUME_MS = 3000; // after the pointer or focus leaves it
    const TOAST_MAX = 3;
    const toastTimers = new Map(); // notification id -> timer
    let toastStack = null;
    let toastOther = null;         // the app's own #toast-container while a ResizeObserver watches it
    let toastResize = null;

    // Keeps this stack just above the app's other toast when both are on screen (they share a corner).
    function syncToastOffset() {
        if (!toastStack) return;
        const other = document.getElementById('toast-container');
        if (other !== toastOther) {
            if (toastResize) { toastResize.disconnect(); }
            toastOther = other;
            if (other && toastResize) toastResize.observe(other);
        }
        const h = other ? other.offsetHeight : 0;
        toastStack.style.setProperty('--nt-offset', h ? (h + 10) + 'px' : '0px');
    }

    function ensureToastStack() {
        if (toastStack && toastStack.isConnected) return toastStack;
        toastStack = el('div');
        toastStack.id = 'notifToastStack';
        toastStack.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastStack);
        if (typeof ResizeObserver === 'function') toastResize = new ResizeObserver(syncToastOffset);
        if (typeof MutationObserver === 'function') new MutationObserver(syncToastOffset).observe(document.body, { childList: true });
        return toastStack;
    }

    function toastFor(id) {
        return toastStack ? Array.from(toastStack.children).find(t => t.dataset.id === id) : null;
    }

    function armToast(id, ms) {
        clearTimeout(toastTimers.get(id));
        toastTimers.set(id, setTimeout(() => dismissToast(id), ms));
    }

    function dismissToast(id) {
        clearTimeout(toastTimers.get(id));
        toastTimers.delete(id);
        const t = toastFor(id);
        if (!t || t.classList.contains('fade-out')) return;
        t.classList.add('fade-out');
        // Performance Mode turns animations off, so 'animationend' may never fire: the timer finishes the job
        // (300ms matches .nt-toast.fade-out, as the app's own toast does).
        let gone = false;
        const finish = () => {
            if (gone) return;
            gone = true;
            t.remove();
            syncToastOffset();
        };
        t.addEventListener('animationend', finish);
        setTimeout(finish, 300);
    }

    function dismissAllToasts() {
        if (!toastStack) return;
        Array.from(toastStack.children).forEach(t => dismissToast(t.dataset.id));
    }

    function showToast(n) {
        const stack = ensureToastStack();
        let t = toastFor(n.id);
        if (t && t.classList.contains('fade-out')) { t.remove(); t = null; }
        if (!t) {
            t = el('div', 'nt-toast');
            t.dataset.id = n.id;
            t.tabIndex = 0;
            t.setAttribute('role', 'status');
            t.title = 'Open in Now Island';

            const head = el('div', 'nt-head');
            const close = el('button', 'nt-close');
            close.type = 'button';
            close.setAttribute('aria-label', 'Dismiss notification');
            close.appendChild(el('i', 'ri-close-line'));
            close.addEventListener('click', (e) => { e.stopPropagation(); dismissToast(n.id); });
            head.append(el('span', 'nt-source'), close);
            t.append(head, el('div', 'nt-title'), el('div', 'nt-text'));

            // stopPropagation: otherwise the click reaches the document's "click outside closes the island" handler,
            // which sees a click outside the panel and closes it again straight after it opened.
            t.addEventListener('click', (e) => { e.stopPropagation(); dismissToast(n.id); openNotification(n.id); });
            t.addEventListener('keydown', (e) => {
                if (e.target !== t) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissToast(n.id); openNotification(n.id); }
                else if (e.key === 'Escape') dismissToast(n.id);
            });
            // Reading it (pointer or keyboard focus) pauses the countdown.
            t.addEventListener('mouseenter', () => clearTimeout(toastTimers.get(n.id)));
            t.addEventListener('mouseleave', () => armToast(n.id, TOAST_RESUME_MS));
            t.addEventListener('focusin', () => clearTimeout(toastTimers.get(n.id)));
            t.addEventListener('focusout', () => armToast(n.id, TOAST_RESUME_MS));
            stack.appendChild(t);
        }
        // Same id again (a repeated notification) refreshes the one toast instead of stacking another.
        t.querySelector('.nt-source').textContent = n.source || 'CodeMini';
        t.querySelector('.nt-title').textContent = n.title;
        t.querySelector('.nt-text').textContent = n.text || '';

        // More than TOAST_MAX at once: the oldest goes immediately (it is still in the list).
        while (stack.children.length > TOAST_MAX) {
            const oldest = stack.firstElementChild;
            clearTimeout(toastTimers.get(oldest.dataset.id));
            toastTimers.delete(oldest.dataset.id);
            oldest.remove();
        }
        syncToastOffset();
        armToast(n.id, TOAST_MS);
    }

    // ---- viewer ----
    function openUpdatesSettings() {
        setOpen(false);
        if (typeof window.openSettingsTab === 'function') window.openSettingsTab('updates');
        else document.getElementById('settingsIconItem')?.click();
    }

    // Opens a sidebar the same way its menu item does (and leaves it alone if it is already open).
    function openSidebarVia(menuId, sidebarId) {
        setOpen(false);
        const sb = document.getElementById(sidebarId);
        if (sb && !sb.classList.contains('open')) document.getElementById(menuId)?.click();
    }

    function openSettingsPage(tabId) {
        setOpen(false);
        if (typeof window.openSettingsTab === 'function') window.openSettingsTab(tabId);
        else document.getElementById('settingsIconItem')?.click();
    }

    const ACTIONS = {
        'reload': { label: 'Reload now', primary: true, show: () => !!(window.CodeMiniPWA && window.CodeMiniPWA.getUpdateState().status === 'updated'), run: () => window.CodeMiniPWA.reload() },
        'open-updates': { label: 'Open Updates settings', primary: false, show: () => true, run: openUpdatesSettings },
        'open-source-control': { label: 'Open Source Control', primary: true, show: () => true, run: () => openSidebarVia('menuSource', 'sourceControlSidebar') },
        'open-keys': { label: 'Open My Keys', primary: true, show: () => true, run: () => openSidebarVia('menuKeys', 'keysSidebar') },
        'open-security': { label: 'Open Security settings', primary: false, show: () => true, run: () => openSettingsPage('security') },
        // Hot exit (file-history.js): compare each recovered file with its saved version. Hidden once those tabs are gone.
        'review-recovered': { label: 'Review', primary: true, show: () => !!(window.CodeMiniHistory && window.CodeMiniHistory.hasReview()), run: () => { if (window.CodeMiniHistory) window.CodeMiniHistory.reviewRecovered(); } },
        // Needs a click (a user gesture): the browser may ask permission. app-alerts.js owns the logic.
        'protect-storage': {
            label: 'Protect my files', primary: true,
            show: () => !!(window.CodeMiniAlerts && window.CodeMiniAlerts.canProtectStorage()),
            run: () => { if (window.CodeMiniAlerts) window.CodeMiniAlerts.protectStorage(); }
        }
    };

    function renderViewer() {
        const n = items.find(x => x.id === openViewerId);
        if (!n) { hideViewer(); return; }
        viewer.textContent = '';

        const header = el('div', 'ni-viewer-header');
        const left = el('div', 'ni-viewer-left');
        const back = iconButton('ri-arrow-left-line', 'Back', 'ni-viewer-back', hideViewer);
        const title = el('div', 'ni-viewer-title', n.title);
        title.title = n.title;
        left.append(back, title);
        header.append(left, iconButton('ri-delete-bin-line', 'Delete', 'danger', () => remove(n.id)));

        const content = el('div', 'ni-viewer-content');
        content.appendChild(el('div', 'ni-viewer-time', new Date(n.time).toLocaleString()));
        content.appendChild(el('div', 'ni-viewer-text', n.text || ''));
        const wanted = (n.actions || []).filter(k => ACTIONS[k] && ACTIONS[k].show());
        if (wanted.length) {
            const row = el('div', 'ni-viewer-actions');
            wanted.forEach(k => {
                const btn = el('button', 'ni-btn' + (ACTIONS[k].primary ? ' primary' : ''), ACTIONS[k].label);
                btn.type = 'button';
                btn.addEventListener('click', (e) => { e.stopPropagation(); ACTIONS[k].run(); });
                row.appendChild(btn);
            });
            content.appendChild(row);
        }
        viewer.append(header, content);
    }

    function showViewer(id) {
        openViewerId = id;
        markRead(id); // opening it is reading it (commit() re-renders, including the viewer)
        renderViewer();
        viewer.classList.add('show');
    }

    function hideViewer() {
        openViewerId = null;
        viewerTask = null;
        viewer._lv = null;
        viewer.setAttribute('aria-label', 'Notification');
        viewer.classList.remove('show');
        viewer.textContent = '';
    }

    // ---- panel + tabs ----
    function setOpen(open) {
        panel.classList.toggle('show', open);
        if (open) dismissAllToasts();
        if (!open) hideViewer();
        if (window.saveCurrentUIState) window.saveCurrentUIState();
    }

    function setActiveTab(index) {
        if (!tabs[index]) index = 0; // a stale or hand-edited saved index
        tabs.forEach((t, i) => t.classList.toggle('active', i === index));
        panes.forEach(p => p.classList.toggle('active', p.dataset.pane === (tabs[index] && tabs[index].dataset.pane)));
        if (index !== 1 || viewerTask) hideViewer(); // the notifications viewer belongs to tab 1, the task-output viewer to tab 0
    }

    function openNotification(id) {
        panel.classList.add('show');
        dismissAllToasts();
        setActiveTab(1);
        if (id) showViewer(id);
        if (window.saveCurrentUIState) window.saveCurrentUIState();
    }

    if (nowIslandBtn) {
        nowIslandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!panel.classList.contains('show'));
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(false);
        });
    }

    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => {
            setActiveTab(i);
            if (window.saveCurrentUIState) window.saveCurrentUIState();
        });
    });

    document.addEventListener('click', (e) => {
        if (panel.classList.contains('show') && !panel.contains(e.target) && (!nowIslandBtn || !nowIslandBtn.contains(e.target))) {
            setOpen(false);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && (openViewerId || viewerTask) && panel.classList.contains('show')) hideViewer();
    });

    // Another tab of the app added or removed something.
    window.addEventListener('storage', (e) => {
        if (e.key !== NOTIF_KEY) return;
        items = loadNotifications();
        render();
    });

    // App updates land here too. pwa.js owns the state; this only mirrors it into a notification.
    function onUpdateState(st) {
        if (!st || st.status !== 'updated') return;
        add({
            id: 'app-update',
            kind: 'update',
            pending: true,
            title: 'Update installed',
            toast: false, // pwa.js already shows its own "updated, reload" toast
            text: 'CodeMini IDE was updated. Reload to use the latest version. Nothing reloads by itself, so your unsaved changes are safe until you choose to.',
            actions: ['reload', 'open-updates']
        });
    }
    window.addEventListener('codemini:update-state', (e) => onUpdateState(e.detail));
    // An update that finished before this script ran (it loads last) must not be missed.
    if (window.CodeMiniPWA && typeof window.CodeMiniPWA.getUpdateState === 'function') onUpdateState(window.CodeMiniPWA.getUpdateState());

    window.CodeMiniNotifications = Object.freeze({
        add,
        remove,
        markRead,
        open: openNotification,
        list: () => items.map(n => Object.assign({}, n)),
        unreadCount,
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
    });


    // 5. Background tasks: RUNNING and RECENTLY FINISHED in the Now pane, Peek, the floating Peek panel, the status-bar spinner and the
    //    spinner on a background window's tab. The registry is js/core/background-tasks.js (no DOM there); everything below is drawn with
    //    createElement and textContent only, because a task's title and output come from user code, a repository or a file name.
    const bg = window.CodeMiniBackground || null;
    const nowPane = panel.querySelector('.ni-pane[data-pane="now"]');
    const peekOpen = new Set();   // tasks whose Peek is expanded in the list
    const isPhone = () => !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);

    function linkButton(text, label, onClick) {
        const b = el('button', 'ni-link', text);
        b.type = 'button';
        if (label) b.setAttribute('aria-label', label);
        // Same reason as iconButton: the node can be replaced by the next refresh before the click reaches the document.
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        return b;
    }

    function pad2(v) { return String(v).padStart(2, '0'); }
    function fmtElapsed(ms) {
        const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return h ? h + ':' + pad2(m) + ':' + pad2(s % 60) : pad2(m) + ':' + pad2(s % 60);
    }
    function fmtTook(ms) {
        const s = Math.max(1, Math.round(ms / 1000));
        return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s';
    }
    const AWAY_NOTE = { app: 'app in background', window: 'in another window', tab: 'in another tab' };
    const END_ICON = { success: 'ri-checkbox-circle-fill', error: 'ri-close-circle-fill', stopped: 'ri-stop-circle-line' };

    // The second line of a row ("Running 00:42, in another tab").
    function subLine(s) {
        if (s.state === 'running') {
            const t = (s.stopping ? 'Stopping ' : 'Running ') + fmtElapsed(Date.now() - s.startedAt);
            return AWAY_NOTE[s.awayReason] ? t + ', ' + AWAY_NOTE[s.awayReason] : t;
        }
        if (s.state === 'error') return s.text || 'It ended with an error';
        if (s.state === 'stopped') return 'Stopped after ' + fmtTook(s.endedAt - s.startedAt);
        return 'Finished in ' + fmtTook(s.endedAt - s.startedAt) + (s.text ? ', ' + s.text : '');
    }

    function openNowTab() {
        panel.classList.add('show');
        dismissAllToasts();
        setActiveTab(0);
        if (window.saveCurrentUIState) window.saveCurrentUIState();
    }
    function goTo(id) { if (bg && bg.goto(id)) setOpen(false); } // the target is on the page, so get out of its way
    function togglePin(id) { if (bg) { if (bg.isPinned(id)) bg.unpin(id); else bg.pin(id); } }

    // ---- the last lines of output, as plain text ----
    function fillLog(box, lines, emptyText) {
        const key = lines.map((l) => l.stream + ':' + l.text).join('\n');
        if (box._key === key) return;
        box._key = key;
        box.textContent = '';
        if (!lines.length) { box.appendChild(el('div', 'ni-peek-empty', emptyText || 'No output yet')); return; }
        lines.forEach((l) => box.appendChild(el('div', 'ni-peek-line' + (l.stream === 'err' ? ' err' : ''), l.text || '\u00a0')));
    }

    // ---- list rows. Built once per task and updated in place: a refresh every second must not replace a button between
    //      the press and the release of a click, nor drop keyboard focus. A row is rebuilt only when its shape changes (it ended). ----
    function buildRow(s) {
        const li = el('li', 'ni-task');
        li.dataset.id = s.id;
        li.dataset.state = s.state;
        const r = li._r = { icon: el('i', 'ni-task-icon'), title: el('div', 'ni-task-title'), sub: el('div', 'ni-task-sub'), actions: el('div', 'ni-task-actions'),
            peekBtn: null, stopBtn: null, bar: null, fill: null, peek: null };
        r.peekBtn = linkButton('Peek', null, () => { if (peekOpen.has(s.id)) peekOpen.delete(s.id); else peekOpen.add(s.id); updateNowPane(); });
        r.actions.appendChild(r.peekBtn);
        if (s.state === 'running') {
            if (s.canGoto) r.actions.appendChild(iconButton('ri-external-link-line', 'Go to', '', () => goTo(s.id)));
            if (s.stoppable) { r.stopBtn = iconButton('ri-stop-mini-fill', 'Stop', 'danger', () => bg.stop(s.id)); r.actions.appendChild(r.stopBtn); }
        } else {
            r.actions.appendChild(iconButton('ri-close-line', 'Dismiss', '', () => bg.dismiss(s.id)));
        }
        const top = el('div', 'ni-task-top');
        top.append(r.icon, r.title, r.actions);
        li.append(top, r.sub);
        if (s.state === 'running') {
            r.bar = el('div', 'ni-task-bar');
            r.bar.setAttribute('role', 'progressbar');
            r.bar.setAttribute('aria-valuemin', '0');
            r.bar.setAttribute('aria-valuemax', '100');
            r.fill = el('span');
            r.bar.appendChild(r.fill);
            li.appendChild(r.bar);
        }
        return li;
    }

    function buildPeek(s) {
        const root = el('div', 'ni-peek');
        const pk = { root, meta: el('div', 'ni-peek-meta'), log: el('div', 'ni-peek-log'), stopLink: null, fullLink: null, pinBtn: null };
        const actions = el('div', 'ni-peek-actions');
        if (s.state === 'running' && s.stoppable) { pk.stopLink = linkButton('Stop', null, () => bg.stop(s.id)); actions.appendChild(pk.stopLink); }
        pk.fullLink = linkButton('View full output', null, () => showLogViewer(s.id));
        actions.appendChild(pk.fullLink);
        pk.pinBtn = iconButton('ri-pushpin-2-line', 'Pin to screen', '', () => togglePin(s.id));
        actions.appendChild(pk.pinBtn);
        root.append(pk.meta, pk.log, actions);
        return pk;
    }

    function updatePeek(pk, s) {
        pk.meta.textContent = s.state === 'running'
            ? 'Elapsed ' + fmtElapsed(Date.now() - s.startedAt) + (s.detail ? ', ' + s.detail : '') + (AWAY_NOTE[s.awayReason] ? ', ' + AWAY_NOTE[s.awayReason] : '')
            : subLine(s);
        fillLog(pk.log, bg.tail(s.id, 4));
        if (pk.stopLink) pk.stopLink.disabled = s.stopping;
        pk.fullLink.hidden = s.lines === 0;
        pk.pinBtn.setAttribute('aria-pressed', String(s.pinned));
        pk.pinBtn.title = s.pinned ? 'Unpin from screen' : 'Pin to screen';
        pk.pinBtn.setAttribute('aria-label', pk.pinBtn.title);
        const ic = pk.pinBtn.firstChild;
        if (ic) ic.className = s.pinned ? 'ri-pushpin-2-fill' : 'ri-pushpin-2-line';
    }

    function updateRow(li, s) {
        const r = li._r;
        r.icon.className = 'ni-task-icon ' + (s.state === 'running' ? s.icon : END_ICON[s.state]);
        r.title.textContent = s.title;
        r.title.title = s.title;
        r.sub.textContent = subLine(s);
        r.peekBtn.setAttribute('aria-label', 'Peek: ' + s.title);
        if (r.stopBtn) r.stopBtn.disabled = s.stopping;
        if (r.bar) {
            const known = s.progress !== null;
            r.bar.classList.toggle('indeterminate', !known);
            r.fill.style.width = known ? Math.round(s.progress * 100) + '%' : '';
            if (known) r.bar.setAttribute('aria-valuenow', String(Math.round(s.progress * 100))); else r.bar.removeAttribute('aria-valuenow');
        }
        const open = peekOpen.has(s.id);
        r.peekBtn.setAttribute('aria-expanded', String(open));
        if (open) {
            if (!r.peek) { r.peek = buildPeek(s); li.insertBefore(r.peek.root, r.bar || null); }
            updatePeek(r.peek, s);
        } else if (r.peek) {
            r.peek.root.remove();
            r.peek = null;
        }
    }

    function reconcileRows(list, snaps) {
        const have = new Map(Array.from(list.children).map((li) => [li.dataset.id, li]));
        snaps.forEach((s, i) => {
            let li = have.get(s.id);
            if (li && li.dataset.state !== s.state) { li.remove(); li = null; }
            if (!li) li = buildRow(s);
            have.delete(s.id);
            updateRow(li, s);
            const at = list.children[i] || null;
            if (at !== li) list.insertBefore(li, at);
        });
        have.forEach((li) => li.remove());
    }

    function buildSection(label, cls, listLabel) {
        const root = el('div', 'ni-sec ' + cls);
        const head = el('div', 'sb-section-header');
        const left = el('span');
        const badge = el('span', 'sb-count-badge', '0');
        left.append(document.createTextNode(label), badge);
        head.appendChild(left);
        const list = el('ul', 'ni-task-list');
        list.setAttribute('aria-label', listLabel);
        root.append(head, list);
        return { root, head, badge, list };
    }

    const secRunning = buildSection('RUNNING', 'ni-sec-running', 'Running tasks');
    const secFinished = buildSection('RECENTLY FINISHED', 'ni-sec-finished', 'Recently finished tasks');
    secFinished.head.appendChild(linkButton('Clear', 'Clear recently finished', () => { if (bg) bg.dismissAllFinished(); }));
    const emptyNow = el('div', 'ni-empty');
    emptyNow.append(el('i', 'ri-checkbox-circle-line'), el('span', null, 'Nothing is running'));
    if (nowPane) nowPane.append(secRunning.root, secFinished.root, emptyNow);

    function updateNowPane() {
        if (!bg || !nowPane) return;
        const run = bg.running(), fin = bg.finished();
        secRunning.root.hidden = !run.length;
        secFinished.root.hidden = !fin.length;
        emptyNow.hidden = run.length + fin.length > 0;
        secRunning.badge.textContent = String(run.length);
        secFinished.badge.textContent = String(fin.length);
        reconcileRows(secRunning.list, run);
        reconcileRows(secFinished.list, fin);
        const live = new Set(run.concat(fin).map((x) => x.id));
        peekOpen.forEach((id) => { if (!live.has(id)) peekOpen.delete(id); });
        if (viewerTask) updateLogViewer();
    }

    // ---- "View full output": the same slide-over the notifications use (it is not a modal) ----
    function showLogViewer(id) {
        if (!bg || !bg.get(id)) return;
        openViewerId = null;
        viewerTask = id;
        viewer.setAttribute('aria-label', 'Task output');
        viewer.textContent = '';
        const header = el('div', 'ni-viewer-header');
        const left = el('div', 'ni-viewer-left');
        const title = el('div', 'ni-viewer-title');
        left.append(iconButton('ri-arrow-left-line', 'Back', 'ni-viewer-back', hideViewer), title);
        header.appendChild(left);
        const content = el('div', 'ni-viewer-content');
        const meta = el('div', 'ni-viewer-time');
        const pre = el('pre', 'ni-log-full');
        const actions = el('div', 'ni-viewer-actions');
        const stopBtn = el('button', 'ni-btn', 'Stop');
        stopBtn.type = 'button';
        stopBtn.addEventListener('click', (e) => { e.stopPropagation(); bg.stop(id); });
        const copyBtn = el('button', 'ni-btn', 'Copy output');
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const text = bg.log(id).map((l) => l.text).join('\n');
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(() => { copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy output'; }, 1500); },
                        () => { copyBtn.textContent = 'Copy failed'; setTimeout(() => { copyBtn.textContent = 'Copy output'; }, 1500); });
                }
            } catch (err) { copyBtn.textContent = 'Copy failed'; }
        });
        actions.append(stopBtn, copyBtn);
        content.append(meta, pre, actions);
        viewer.append(header, content);
        viewer._lv = { title, content, meta, pre, stopBtn };
        viewer.classList.add('show');
        updateLogViewer();
    }

    function updateLogViewer() {
        const lv = viewer._lv, s = viewerTask && bg ? bg.get(viewerTask) : null;
        if (!lv || !s) { hideViewer(); return; }
        const atEnd = lv.content.scrollHeight - lv.content.scrollTop - lv.content.clientHeight < 24;
        lv.title.textContent = s.title;
        lv.title.title = s.title;
        lv.meta.textContent = 'Started ' + new Date(s.startedAt).toLocaleTimeString() + '. ' + subLine(s);
        const lines = bg.log(s.id);
        const key = lines.map((l) => l.stream + ':' + l.text).join('\n');
        if (lv.pre._key !== key) {
            lv.pre._key = key;
            lv.pre.textContent = '';
            if (!lines.length) lv.pre.appendChild(el('span', 'ni-peek-empty', 'No output'));
            lines.forEach((l) => lv.pre.appendChild(el('div', l.stream === 'err' ? 'err' : null, l.text || '\u00a0')));
        }
        lv.stopBtn.hidden = !(s.state === 'running' && s.stoppable);
        lv.stopBtn.disabled = s.stopping;
        if (atEnd) lv.content.scrollTop = lv.content.scrollHeight;
    }

    // ---- the status-bar button: spinner + running count instead of the icon, a brief check or cross, a tooltip ----
    let runEl = null, runRing = null, runCount = null, flashTimer = null;
    if (nowIslandBtn) {
        runEl = el('span', 'ni-run');
        runRing = el('span', 'ni-run-ring');
        runRing.setAttribute('aria-hidden', 'true');
        runCount = el('span', 'ni-run-count');
        runEl.append(runRing, runCount);
        nowIslandBtn.appendChild(runEl);
    }

    // One place writes the button's label, because both the unread count and the running count feed it.
    function updateButtonLabel() {
        if (!nowIslandBtn) return;
        const running = bg ? bg.runningCount() : 0, unread = unreadCount();
        const parts = [];
        if (running) parts.push(running + ' running');
        if (unread) parts.push(unread + ' unread');
        if (!parts.length) { nowIslandBtn.removeAttribute('aria-label'); nowIslandBtn.removeAttribute('title'); return; }
        nowIslandBtn.title = parts.join(', ');
        // With nothing running this is the sentence it has always been.
        nowIslandBtn.setAttribute('aria-label', running ? 'Now Island, ' + parts.join(', ') : 'Now Island, ' + unread + ' unread notification' + (unread === 1 ? '' : 's'));
    }

    function updateStatus() {
        if (!bg || !nowIslandBtn) return;
        const n = bg.runningCount();
        nowIslandBtn.classList.toggle('has-running', n > 0);
        runCount.textContent = n > 0 ? String(n) : '';
        const f = bg.takeFlash();
        if (f && f.state !== 'stopped') {
            runRing.className = 'ni-run-ring flash ' + (f.state === 'error' ? 'bad ri-close-line' : 'ok ri-check-line');
            nowIslandBtn.classList.add('ni-flash');
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => { nowIslandBtn.classList.remove('ni-flash'); runRing.className = 'ni-run-ring'; }, 1200);
        }
        updateButtonLabel();
    }

    // A window that is not the active one and has something running gets a small spinner on its tab.
    function syncWindowTabs() {
        const bar = document.getElementById('windowBar');
        if (!bar || !bg) return;
        let active = 'win_default';
        try { active = localStorage.getItem('codemini_active_window') || 'win_default'; } catch (e) { /* default window */ }
        const busy = new Set(bg.running().filter((s) => s.winId).map((s) => s.winId));
        bar.querySelectorAll('.window-tab[data-id]').forEach((t) => t.classList.toggle('has-running', busy.has(t.dataset.id) && t.dataset.id !== active));
    }

    // ---- the floating Peek panel (a task the person pinned) ----
    const dock = el('div');
    dock.id = 'niPeekDock';
    dock.hidden = true;
    document.body.appendChild(dock);
    const dockMore = el('button', 'ni-pp-more');
    dockMore.type = 'button';
    dockMore.addEventListener('click', (e) => { e.stopPropagation(); openNowTab(); });
    const collapsedPanels = new Set(), keptPanels = new Set(), fadeTimers = new Map();
    const PANEL_FADE_MS = 8000, PANEL_FADE_RESUME_MS = 3000;

    function panelFor(id) { return Array.from(dock.children).find((c) => c.dataset && c.dataset.id === id) || null; }
    function clearFade(id) { clearTimeout(fadeTimers.get(id)); fadeTimers.delete(id); }
    function armFade(id, ms) {
        clearFade(id);
        fadeTimers.set(id, setTimeout(() => {
            const p = panelFor(id);
            if (!p || keptPanels.has(id)) { fadeTimers.delete(id); return; }
            p.classList.add('fade-out');
            // Animations can be switched off (reduced motion, Performance Mode): the timer, not animationend, finishes the job.
            setTimeout(() => { fadeTimers.delete(id); if (bg) bg.unpin(id); }, 260);
        }, ms));
    }
    function closePanel(id) { clearFade(id); if (bg) bg.unpin(id); } // the task itself carries on (or stays in RECENTLY FINISHED)

    function buildPanel(s) {
        const p = el('div', 'ni-pp');
        p.dataset.id = s.id;
        p.setAttribute('role', 'group');
        const r = p._r = { icon: el('i', 'ni-pp-icon'), title: el('div', 'ni-pp-title'), time: el('span', 'ni-pp-time'), body: el('div', 'ni-pp-body'),
            note: el('span', 'ni-pp-note'), foot: el('div', 'ni-pp-foot'), footKey: '', goBtn: null, keepBtn: null, collBtn: null };
        const head = el('div', 'ni-pp-head');
        r.keepBtn = iconButton('ri-pushpin-2-line', 'Keep open', '', () => {
            if (keptPanels.has(s.id)) { keptPanels.delete(s.id); } else { keptPanels.add(s.id); clearFade(s.id); }
            syncDock();
        });
        r.collBtn = iconButton('ri-subtract-line', 'Collapse', '', () => {
            if (collapsedPanels.has(s.id)) collapsedPanels.delete(s.id); else collapsedPanels.add(s.id);
            syncDock();
        });
        head.append(r.icon, r.title, r.time);
        if (s.canGoto) head.appendChild(iconButton('ri-external-link-line', 'Go to', '', () => bg.goto(s.id)));
        head.append(r.keepBtn, r.collBtn, iconButton('ri-close-line', 'Close', '', () => closePanel(s.id)));
        p.append(head, r.body, r.foot);
        if (isPhone()) collapsedPanels.add(s.id); // on a phone a panel starts as a one-line strip
        // Hovering or focusing it holds the countdown, like the toasts.
        p.addEventListener('mouseenter', () => clearFade(s.id));
        p.addEventListener('mouseleave', () => { if (fadeTimers.has(s.id) || /^(success|stopped)$/.test(p.dataset.state)) { if (!keptPanels.has(s.id)) armFade(s.id, PANEL_FADE_RESUME_MS); } });
        p.addEventListener('focusin', () => clearFade(s.id));
        // Esc only does something while the panel itself has focus: it never steals the key from the editor.
        p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(s.id); } });
        // A swipe to the right dismisses it on a phone.
        let sx = 0, sy = 0;
        p.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
        p.addEventListener('touchend', (e) => {
            if (!isPhone()) return;
            const t = e.changedTouches[0];
            if (t.clientX - sx > 70 && Math.abs(t.clientY - sy) < 40) closePanel(s.id);
        }, { passive: true });
        return p;
    }

    function updatePanel(p, s) {
        const r = p._r, id = s.id;
        p.dataset.state = s.state;
        p.setAttribute('aria-label', 'Task: ' + s.title);
        r.icon.className = 'ni-pp-icon ' + (s.state === 'running' ? s.icon : END_ICON[s.state]);
        r.title.textContent = s.title;
        r.title.title = s.title;
        r.time.textContent = s.state === 'running' ? fmtElapsed(Date.now() - s.startedAt) : fmtTook(s.endedAt - s.startedAt);
        fillLog(r.body, bg.tail(id, 4));
        const collapsed = collapsedPanels.has(id);
        p.classList.toggle('collapsed', collapsed);
        r.collBtn.title = collapsed ? 'Expand' : 'Collapse';
        r.collBtn.setAttribute('aria-label', r.collBtn.title);
        r.collBtn.firstChild.className = collapsed ? 'ri-add-line' : 'ri-subtract-line';
        r.keepBtn.setAttribute('aria-pressed', String(keptPanels.has(id)));
        // The foot is rebuilt only when what it offers changes.
        const key = s.state + '|' + s.stopping + '|' + s.stoppable + '|' + s.canGoto;
        if (r.footKey !== key) {
            r.footKey = key;
            r.foot.textContent = '';
            r.foot.appendChild(r.note);
            if (s.state === 'running' && s.stoppable) { const b = linkButton('Stop', null, () => bg.stop(id)); b.disabled = s.stopping; r.foot.appendChild(b); }
            if (s.state === 'error') r.foot.appendChild(linkButton('Open', null, () => { if (!bg.goto(id)) openNowTab(); }));
        }
        r.note.textContent = s.state === 'running' ? (s.stopping ? 'Stopping' : 'Running') + (s.detail ? ', ' + s.detail : '')
            : s.state === 'error' ? (s.text || 'It ended with an error') : s.state === 'stopped' ? 'Stopped' : 'Finished in ' + fmtTook(s.endedAt - s.startedAt);
        // Success fades after a while unless it is hovered or kept; a failure stays until it is closed.
        if (s.state === 'success' || s.state === 'stopped') {
            if (!keptPanels.has(id) && !fadeTimers.has(id) && !p.matches(':hover') && !p.contains(document.activeElement)) armFade(id, PANEL_FADE_MS);
        } else clearFade(id);
    }

    let dockDragged = false;
    function placeDock(x, y) {
        const w = dock.offsetWidth, h = dock.offsetHeight;
        x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
        y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h));
        dockDragged = true;
        dock.classList.add('dragged');
        dock.style.left = x + 'px';
        dock.style.top = y + 'px';
    }
    function resetDockPlace() { dockDragged = false; dock.classList.remove('dragged'); dock.style.left = ''; dock.style.top = ''; }

    function syncDock() {
        if (!bg) return;
        const pinned = bg.pinned();
        const covered = panel.classList.contains('show'); // hidden while the island is open: the same rows are in front of the person
        dock.hidden = covered || !pinned.length;
        if (dock.hidden) return;
        if (isPhone() && dockDragged) resetDockPlace();
        const max = isPhone() ? 2 : 3, shown = pinned.slice(0, max);
        const have = new Map(Array.from(dock.children).filter((c) => c.classList.contains('ni-pp')).map((c) => [c.dataset.id, c]));
        shown.forEach((s, i) => {
            let p = have.get(s.id);
            if (!p) p = buildPanel(s);
            have.delete(s.id);
            updatePanel(p, s);
            const at = dock.children[i] || null;
            if (at !== p) dock.insertBefore(p, at);
        });
        have.forEach((p, id) => p.remove());
        const live = new Set(pinned.map((x) => x.id));
        [collapsedPanels, keptPanels].forEach((set) => set.forEach((id) => { if (!live.has(id)) set.delete(id); }));
        Array.from(fadeTimers.keys()).forEach((id) => { if (!live.has(id)) clearFade(id); });
        if (pinned.length > shown.length) {
            dockMore.textContent = '+' + (pinned.length - shown.length) + ' more';
            if (dockMore.parentNode !== dock) dock.appendChild(dockMore);
        } else if (dockMore.parentNode === dock) dock.removeChild(dockMore);
        if (dockDragged) placeDock(parseFloat(dock.style.left) || 0, parseFloat(dock.style.top) || 0); // the dock may have grown: keep it on screen
    }

    // Drag by the header (not on a phone, where the strip has a fixed place).
    let drag = null;
    dock.addEventListener('pointerdown', (e) => {
        const head = e.target.closest ? e.target.closest('.ni-pp-head') : null;
        if (!head || e.target.closest('button') || isPhone() || e.button > 0) return;
        const rect = dock.getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        try { head.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer: the move events still arrive */ }
        e.preventDefault();
    });
    dock.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) placeDock(e.clientX - drag.dx, e.clientY - drag.dy); });
    const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    dock.addEventListener('pointerup', endDrag);
    dock.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => { if (dockDragged && !dock.hidden) placeDock(parseFloat(dock.style.left) || 0, parseFloat(dock.style.top) || 0); });

    function syncAll() {
        updateStatus();
        syncWindowTabs();
        if (panel.classList.contains('show')) updateNowPane();
        syncDock();
    }

    if (bg) {
        bg.subscribe(syncAll);
        // The island opens and closes by toggling a class from several places (button, toast, restore): watch the class instead of every caller.
        if (typeof MutationObserver === 'function') new MutationObserver(() => { if (panel.classList.contains('show')) updateNowPane(); syncDock(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
        // The window bar is rebuilt from scratch whenever windows change: put the spinners back.
        const winBar = document.getElementById('windowBar');
        if (winBar && typeof MutationObserver === 'function') new MutationObserver(syncWindowTabs).observe(winBar, { childList: true });
        syncAll();
    }

    commit(); // first render (also persists the "update applied" conversion above)

    // 4. Connect to Isolated Profile Window Registry
    document.addEventListener('DOMContentLoaded', () => {
        
        // Patch save function
        if (typeof window.saveCurrentUIState === 'function') {
            const originalSave = window.saveCurrentUIState;
            window.saveCurrentUIState = function() {
                originalSave();
                const winId = localStorage.getItem('codemini_active_window') || 'win_default';
                const isOpen = panel.classList.contains('show');
                const activeTabEl = panel.querySelector('.ni-tab.active');
                const activeTabIndex = activeTabEl ? Array.from(tabs).indexOf(activeTabEl) : 0;
                localStorage.setItem(`codemini_nowisland_state_${winId}`, JSON.stringify({ isOpen, activeTabIndex }));
            };
        }

        // Patch restore function
        if (typeof window.restoreCurrentUIState === 'function') {
            const originalRestore = window.restoreCurrentUIState;
            window.restoreCurrentUIState = function() {
                originalRestore();
                const winId = localStorage.getItem('codemini_active_window') || 'win_default';
                let activeTabIndex = 0;
                try {
                    const saved = JSON.parse(localStorage.getItem(`codemini_nowisland_state_${winId}`));
                    if (saved && saved.isOpen) {
                        panel.classList.add('show');
                    } else {
                        panel.classList.remove('show');
                    }
                    if (saved && Number.isInteger(saved.activeTabIndex)) activeTabIndex = saved.activeTabIndex;
                } catch(e) {
                    panel.classList.remove('show');
                }
                // Without this, whichever tab (Now / Notifications) was last
                // clicked in ANY window stays visually selected after
                // switching, since the tabs themselves are a DOM singleton
                // that switchWindow never rebuilds - it just looked like the
                // new window "remembered" the old window's last tab choice.
                setActiveTab(activeTabIndex);
                if (!panel.classList.contains('show')) hideViewer();
                if (bg) syncAll();
            };
        }

        // Initial restore pass
        if (typeof window.restoreCurrentUIState === 'function') {
            window.restoreCurrentUIState();
        }
    });
})();
