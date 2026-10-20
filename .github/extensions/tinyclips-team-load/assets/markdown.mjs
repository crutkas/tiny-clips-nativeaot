// Allowlist sanitizer for GitHub-rendered markdown (bodyHTML). Runs in the browser.
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "OBJECT", "EMBED", "FORM", "TEMPLATE", "SVG", "MATH", "LINK", "META", "BASE", "NOSCRIPT", "BUTTON", "TEXTAREA", "SELECT", "DIALOG"]);
const KEEP = new Set(["A", "P", "BR", "HR", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "EM", "STRONG", "B", "I", "DEL", "S", "INS", "SUP", "SUB", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "IMG", "DETAILS", "SUMMARY", "SPAN", "DIV", "INPUT", "KBD", "G-EMOJI", "MARK", "SMALL", "DL", "DT", "DD", "PICTURE", "VIDEO"]);
const ATTRS = {
    "*": ["title"],
    A: ["href"],
    IMG: ["src", "alt", "width", "height"],
    TD: ["colspan", "rowspan", "align"],
    TH: ["colspan", "rowspan", "align"],
    OL: ["start"],
    INPUT: ["type", "checked"],
    DETAILS: ["open"],
    VIDEO: ["src"],
};

function safeUrl(value, base, { image = false } = {}) {
    if (!value) return null;
    let url;
    try { url = new URL(value, base); } catch { return null; }
    if (image) return url.protocol === "https:" ? url.href : null;
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

export function sanitizeHtml(html, { base = "https://github.com/", parseItemUrl = () => null } = {}) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const walk = node => {
        for (const child of [...node.childNodes]) {
            if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const tag = child.tagName.toUpperCase();
            if (DROP.has(tag)) { child.remove(); continue; }
            if (!KEEP.has(tag)) { walk(child); child.replaceWith(...child.childNodes); continue; }
            const allowed = new Set([...(ATTRS["*"]), ...(ATTRS[tag] ?? [])]);
            for (const attr of [...child.attributes]) if (!allowed.has(attr.name.toLowerCase())) child.removeAttribute(attr.name);
            if (tag === "A") {
                const href = safeUrl(child.getAttribute("href"), base);
                if (!href) child.removeAttribute("href");
                else {
                    child.setAttribute("href", href);
                    const ref = parseItemUrl(href);
                    if (ref) child.dataset.item = `${ref.repository}#${ref.number}`;
                    child.setAttribute("target", "_blank");
                    child.setAttribute("rel", "noopener noreferrer");
                }
            }
            if (tag === "IMG" || tag === "VIDEO") {
                const src = safeUrl(child.getAttribute("src"), base, { image: true });
                if (!src) { child.remove(); continue; }
                child.setAttribute("src", src);
                child.setAttribute("loading", "lazy");
                child.setAttribute("referrerpolicy", "no-referrer");
                if (tag === "VIDEO") child.setAttribute("controls", "");
            }
            if (tag === "INPUT") {
                if (child.getAttribute("type") !== "checkbox") { child.remove(); continue; }
                child.setAttribute("disabled", "");
            }
            walk(child);
        }
    };
    walk(doc.body);
    const fragment = document.createDocumentFragment();
    fragment.append(...doc.body.childNodes);
    return fragment;
}
