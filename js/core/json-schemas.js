// One place that tells Monaco's JSON language service which schema applies to which in-memory document.
// Monaco's setDiagnosticsOptions REPLACES everything it was given before, so two features that each call it would undo
// each other. The snippet editor and the settings.json view both register here, and this applies the union.
//
//   CodeMiniJsonSchemas.add(schemaUri, modelUris, schema)   modelUris: the exact URIs of the models it applies to
//
// Monaco is loaded late (from the CDN, on demand), so registrations made before it is ready are kept and applied the
// moment it is. The pure half is exported for Node (tests/json-schemas.test.js).
(function (root) {
    'use strict';
    const W = root;

    // Merges a registration into a list of { uri, fileMatch, schema }. Same schema uri: the match lists are joined.
    function mergeSchema(list, uri, fileMatch, schema) {
        const next = list.slice();
        const i = next.findIndex((s) => s.uri === uri);
        const matches = Array.from(new Set([].concat(i >= 0 ? next[i].fileMatch : [], fileMatch || [])));
        const entry = { uri, fileMatch: matches, schema: schema || (i >= 0 ? next[i].schema : {}) };
        if (i >= 0) next[i] = entry; else next.push(entry);
        return next;
    }

    const api = { mergeSchema };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return;

    let schemas = [];
    let applied = false;
    function defaults() { const m = W.monaco; return m && m.languages && m.languages.json && m.languages.json.jsonDefaults ? m.languages.json.jsonDefaults : null; }
    function apply() {
        const d = defaults();
        if (!d) return false;
        d.setDiagnosticsOptions({ validate: true, schemas: schemas.map((s) => ({ uri: s.uri, fileMatch: s.fileMatch, schema: s.schema })) });
        applied = true;
        return true;
    }
    function add(uri, fileMatch, schema) {
        schemas = mergeSchema(schemas, uri, fileMatch, schema);
        return apply();
    }
    // Monaco may arrive after the first registration: apply as soon as it does (for up to three minutes).
    let waited = 0;
    const timer = setInterval(() => {
        waited += 300;
        if (applied || waited > 180000) { clearInterval(timer); return; }
        if (schemas.length && apply()) clearInterval(timer);
    }, 300);

    Object.assign(api, { add, apply, list: () => schemas.slice() });
    W.CodeMiniJsonSchemas = api;
})(typeof window !== 'undefined' ? window : globalThis);
