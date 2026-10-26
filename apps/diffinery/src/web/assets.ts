import { UI_ICONS } from "./icons.ui.generated.js";

/** Inline stylesheet, client script and icons for the web UI (no external assets). */

/**
 * Dark theme tokens. Settings → Appearance puts data-theme="light" or "dark" on <html>; without it the
 * system setting decides. Dark-only rules elsewhere use the same two selectors (see `dark()`).
 */
const DARK_TOKENS = `--canvas:oklch(10% 0 0);--bg:oklch(17% 0 0);--bg2:oklch(12% 0 0);--bg3:oklch(15% 0 0);--bg-hover:oklch(26.9% 0 0);
--fg:oklch(97% 0 0);--fg2:oklch(70.8% 0 0);--fg3:oklch(55.6% 0 0);
--border:oklch(32% 0 0);--border2:oklch(26.9% 0 0);
--accent:oklch(48.8% 0.243 264.376);--accent-hover:oklch(54.6% 0.245 262.881);--accent-fg:#fff;--accent-soft:oklch(38% 0.145 265.5 / .22);
--link:oklch(70.7% 0.165 254.624);--focus:oklch(93.5% 0 0);
--green:oklch(76.5% 0.177 163.223);--green-soft:oklch(39.3% 0.096 152.3 / .2);--red:oklch(70.4% 0.191 22.216);--red-soft:oklch(42.9% 0.176 28.7 / .17);
--amber:oklch(75% 0.183 55.934);--amber-soft:oklch(35.3% 0.079 65 / .37);
--purple:oklch(71.4% 0.203 305.504);--purple-soft:oklch(49.6% 0.265 301.924 / .2);--blue:oklch(70.7% 0.165 254.624);--blue-soft:oklch(38% 0.145 265.5 / .22);
--add-bg:oklch(39.3% 0.096 152.3 / .2);--add-ln:oklch(39.3% 0.096 152.3 / .4);--del-bg:oklch(42.9% 0.176 28.7 / .17);--del-ln:oklch(42.9% 0.176 28.7 / .35);--hunk-bg:oklch(38% 0.145 265.5 / .22);--hl:oklch(55.4% 0.135 66.442 / .5);
--code-bg:oklch(15% 0 0);--shadow:0 0 0 1px oklch(100% 0 0 / .1),0 8px 24px oklch(0% 0 0 / .3)`;
const under = (prefix: string, sel: string): string => sel.split(",").map((x) => `${prefix} ${x.trim()}`).join(",");
/** A dark-mode rule: applies with data-theme="dark", and with the system setting unless data-theme="light". */
export const dark = (sel: string, decls: string): string =>
  `@media (prefers-color-scheme:dark){${under(":root:not([data-theme=light])", sel)}{${decls}}}${under(":root[data-theme=dark]", sel)}{${decls}}`;
const DARK = `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK_TOKENS}}}:root[data-theme=dark]{${DARK_TOKENS}}
:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}`;

export const CSS = `
/* Cascade order: the site's own styles first, then Kumo's (build/islands/kumo.css, confined to .dfy-k
   islands), then island layout. kumo-reset reverts site styles inside islands so Kumo controls look
   exactly like Kumo. */
@layer site,kumo-reset,properties,theme,base,components,utilities,islands;
@layer site{
:root{color-scheme:light dark;
/* Colors, radii and type follow Cloudflare's Kumo design system tokens (kumo-ui.com, MIT). */
--canvas:oklch(98.75% 0 0);--bg:#fff;--bg2:oklch(98% 0 0);--bg3:oklch(96% 0 0);--bg-hover:oklch(97% 0 0);
--fg:oklch(21% 0.006 285.885);--fg2:oklch(55.6% 0 0);--fg3:oklch(70.8% 0 0);
--border:oklch(14.5% 0 0 / .1);--border2:oklch(93.5% 0 0);
--accent:oklch(48.8% 0.243 264.376);--accent-hover:oklch(54.6% 0.245 262.881);--accent-fg:#fff;--accent-soft:oklch(93.2% 0.032 255.6 / .45);
--link:oklch(42.4% 0.199 265.638);--focus:oklch(15% 0 0);
--green:oklch(43.2% 0.095 166.913);--green-soft:oklch(96.2% 0.043 156.7 / .57);--red:oklch(50.5% 0.213 27.518);--red-soft:oklch(93.6% 0.032 17.7 / .42);
--amber:oklch(59.7% 0.144 57.5);--amber-soft:oklch(93.1% 0.107 94.6 / .2);
--purple:oklch(55.8% 0.288 302.321);--purple-soft:oklch(55.8% 0.288 302.321 / .1);--blue:oklch(42.4% 0.199 265.638);--blue-soft:oklch(93.2% 0.032 255.6 / .45);
--brand:#f6821f;
--add-bg:oklch(96.2% 0.043 156.7 / .57);--add-ln:oklch(90.5% 0.093 164.15 / .7);--del-bg:oklch(93.6% 0.032 17.7 / .42);--del-ln:oklch(88.5% 0.062 18.334 / .7);--hunk-bg:oklch(93.2% 0.032 255.6 / .45);--hl:oklch(97.3% 0.071 103.193);
--code-bg:oklch(96% 0 0);--shadow:0 0 0 1px oklch(0% 0 0 / .12),0 8px 24px oklch(0% 0 0 / .08);--r:.5rem;--r-sm:.375rem;
--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","Noto Sans",Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"}
${DARK}
*{box-sizing:border-box}
/* Phosphor icons sit on the text's center line when inline; flex containers center them themselves. */
svg[viewBox="0 0 256 256"]{vertical-align:-3px;flex:none}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--canvas);color:var(--fg);font:14px/1.5 var(--sans)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code,pre,kbd,.mono{font-family:var(--mono);font-size:12.5px}
kbd{border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 5px;background:var(--bg2);font-size:11px;color:var(--fg2)}
h1,h2,h3,h4{line-height:1.25;margin:0 0 8px}h1{font-size:22px}h2{font-size:18px}h3{font-size:15px}
p{margin:0 0 10px}
hr{border:0;border-top:1px solid var(--border);margin:16px 0}
.muted{color:var(--fg2)}.faint{color:var(--fg3)}.small{font-size:12px}.nowrap{white-space:nowrap}
.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}.run{color:var(--amber)}.merged{color:var(--purple)}
.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(1.6) blur(10px);border-bottom:1px solid var(--border)}
.top .wrap{display:flex;align-items:center;gap:14px;height:52px}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;color:var(--fg);letter-spacing:-.01em;white-space:nowrap}
.brand:hover{text-decoration:none}.brand svg{color:var(--brand)}
.top nav{display:flex;align-items:center;gap:4px;margin-left:auto}
/* Nav link styles skip buttons (Sign in), so a .btn keeps its own colours and hover. */
.top nav a:not(.btn){color:var(--fg2);padding:6px 10px;border-radius:6px}.top nav a:not(.btn):hover{background:var(--bg-hover);color:var(--fg);text-decoration:none}
.pal-btn{display:flex;align-items:center;gap:8px;min-width:220px;padding:5px 10px;border:1px solid var(--border);border-radius:7px;background:var(--bg2);color:var(--fg3);font:inherit;cursor:pointer}
.pal-btn:hover{border-color:var(--fg3)}.pal-btn kbd{margin-left:auto;white-space:nowrap}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-left:2px;vertical-align:top}
.wrap{max-width:1280px;margin:0 auto;padding:0 20px}
main.wrap{padding-top:20px;padding-bottom:60px}
.flash{border:1px solid;border-radius:var(--r);padding:10px 14px;margin:0 0 16px}
.flash.error{border-color:color-mix(in srgb,var(--red) 40%,transparent);background:var(--red-soft);color:var(--red)}
.flash.notice{border-color:color-mix(in srgb,var(--green) 40%,transparent);background:var(--green-soft);color:var(--green)}
.flash.info{border-color:color-mix(in srgb,var(--blue) 40%,transparent);background:var(--blue-soft)}
.flash.warn{border-color:color-mix(in srgb,var(--amber) 40%,transparent);background:var(--amber-soft);color:var(--amber)}
/* Footer: full-width band; brand and link columns across the page width, then a bottom bar. */
.site-foot{border-top:1px solid var(--border2);background:var(--bg2);font-size:13px;color:var(--fg3)}
.site-foot a{color:var(--fg2)}.site-foot a:hover,.site-foot .brand{color:var(--fg);text-decoration:none}
.site-foot .foot-main{display:grid;grid-template-columns:minmax(0,1.7fr) repeat(4,minmax(0,1fr));gap:40px 32px;padding-top:56px;padding-bottom:48px}
.foot-brand{display:flex;flex-direction:column;align-items:flex-start;gap:14px}.foot-brand .brand{font-size:16px}
.foot-brand p{margin:0;max-width:320px;line-height:1.6;color:var(--fg2)}.foot-brand p strong{color:var(--fg);font-weight:550}
.site-foot .foot-brand .btn{color:var(--fg)}
.foot-main nav{display:flex;flex-direction:column;align-items:flex-start;gap:11px}.foot-main h2{font-size:13px;font-weight:600;color:var(--fg);margin:0 0 3px}
.foot-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px 24px;padding:20px 0 28px;font-size:12px}
.foot-main+.wrap>.foot-bar{border-top:1px solid var(--border2)}.foot-bar nav{display:flex;flex-wrap:wrap;gap:20px}
@media (max-width:1000px){.site-foot .foot-main{grid-template-columns:repeat(4,minmax(0,1fr));padding-top:44px}.foot-brand{grid-column:1/-1}.foot-brand p{max-width:520px}}
@media (max-width:600px){.site-foot .foot-main{grid-template-columns:repeat(2,minmax(0,1fr));gap:32px 16px;padding-top:36px;padding-bottom:36px}.top nav a.nav-site{display:none}}
/* "Star on GitHub" (StarButton in ui.tsx): GitHub's own shape, a label and a count split by a rule. */
.btn.gh-star .gh-count{display:inline-flex;align-items:center;gap:3px;margin-left:4px;padding-left:9px;align-self:stretch;border-left:1px solid var(--border);color:var(--fg2);font-variant-numeric:tabular-nums}
.btn.gh-star.sm .gh-count{margin-left:2px;padding-left:7px}
.btn.gh-star .gh-count svg{width:12px;height:12px}
.btn.gh-star:hover .gh-count{color:var(--fg)}
.top nav .nav-star{margin:0 8px 0 6px}
@media (max-width:600px){.top nav .nav-star{margin:0 6px 0 2px}.top nav .nav-star .gh-star-label{display:none}.top nav .nav-star .gh-count{margin-left:0;padding-left:5px}}
/* Controls follow Kumo sizes: base 36px (buttons, inputs, selects), sm 26px. */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg);color:var(--fg);font:500 14px/1 var(--sans);cursor:pointer;white-space:nowrap;text-decoration:none!important;vertical-align:middle;flex:none}
.btn svg{flex:none}
.btn:hover{background:var(--bg-hover);border-color:var(--fg3)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);box-shadow:inset 0 1px 0 0 oklch(100% 0 0 / .15)}.btn.primary:hover{background:var(--accent-hover)}
.btn.green{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}.btn.green:hover{background:var(--accent-hover)}
.btn.danger{color:var(--red)}.btn.danger:hover{background:var(--red);border-color:var(--red);color:#fff}
.btn.sm{height:26px;padding:0 8px;gap:4px;font-size:12px;border-radius:var(--r-sm)}.btn.sm svg{width:14px;height:14px}.btn.icon{width:36px;padding:0}.btn.sm.icon{width:26px}
.btn.link{border-color:transparent;background:none;color:var(--accent);padding:0;height:auto}
.btn[disabled]{opacity:.5;cursor:not-allowed}
input[type=text],input[type=search],input[type=email],input[type=number],input[type=url],input[type=password],input:not([type]),textarea{
width:100%;height:36px;padding:0 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg);color:var(--fg);font:inherit}
input[type=file]{display:block;width:100%;font:inherit;font-size:13px;color:var(--fg2);padding:6px 0}
input[type=file]::file-selector-button{height:30px;margin-right:10px;padding:0 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg);color:var(--fg);font:500 13px/1 var(--sans);cursor:pointer}
input[type=file]::file-selector-button:hover{background:var(--bg-hover)}
.checklist{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
textarea{height:auto;padding:8px 12px;line-height:1.5;min-height:120px;resize:vertical;font-family:var(--sans)}textarea.code{font-family:var(--mono);font-size:12.5px;min-height:420px;tab-size:4;white-space:pre}
input:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--focus) 25%,transparent);outline-offset:0;border-color:color-mix(in srgb,var(--focus) 50%,transparent)}
:focus-visible{outline:2px solid color-mix(in srgb,var(--focus) 35%,transparent);outline-offset:2px}
label{display:block;font-weight:550;margin:0 0 4px}label.inline{display:inline-flex;align-items:center;gap:6px;font-weight:400}
.field{margin:0 0 14px}.field .hint{font-size:12px;color:var(--fg2);margin-top:4px;font-weight:400}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row.end{justify-content:flex-end}.row.between{justify-content:space-between}
.grow{flex:1;min-width:0}
.row.nowrap{flex-wrap:nowrap}
/* A one-line form: fields and the submit button share a baseline at the control's bottom edge. */
.formrow{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.formrow>.field{margin:0}.formrow>.field.grow{min-width:220px}
.formrow+.hint{font-size:12px;color:var(--fg2);margin-top:8px}
/* Settings forms (.fbody): titled sections, a grid of labelled fields that align on their labels and
   controls (one column when the form is narrow), checkbox lists with the helper text under each label,
   and a footer for the submit button. */
.fbody{container-type:inline-size}
.fsec{padding:20px 0;border-top:1px solid var(--border2)}.fsec:first-of-type{padding-top:0;border-top:0}
.fsec>h3{font-size:14px;margin:0 0 12px}.fsec>.fsec-d{font-size:13px;color:var(--fg2);margin:-8px 0 12px}
.fsec>:last-child,.fbody .field:last-child{margin-bottom:0}
.fgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;margin:0 0 16px}.fgrid.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
.fgrid>.field{margin:0;min-width:0}.fgrid>.span2{grid-column:span 2}.fgrid>.full{grid-column:1/-1}
@container (max-width:560px){.fgrid,.fgrid.c3{grid-template-columns:minmax(0,1fr)}.fgrid>.span2{grid-column:auto}}
.fchecks{display:flex;flex-direction:column;align-items:flex-start;gap:12px;margin:0 0 16px}
.fchecks.cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px 16px}
.fbody textarea{min-height:0}
.factions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--border2)}.fsec+.factions{margin-top:0}
/* A setting with its button: text on the left, the button on the right, stacked on phones. */
.drow{display:flex;gap:16px;align-items:center;justify-content:space-between}.drow>div{flex:1;min-width:0}
@media (max-width:600px){.drow{flex-direction:column;align-items:flex-start;gap:10px}}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 296px;gap:24px}
.grid.left{grid-template-columns:260px minmax(0,1fr)}
@media (max-width:900px){.grid,.grid.left{grid-template-columns:minmax(0,1fr)}.grid.left>.side.after{order:2}.pal-btn{min-width:0}.pal-btn span{display:none}}@media (max-width:600px){.pal-btn kbd{display:none}.top .wrap{gap:8px}.top nav{gap:0}.top nav a:not(.btn){padding:6px 8px}.top .who>span{display:none}.top .navbtn{padding:6px 8px}}@media (max-width:360px){.brand>span{display:none}}
.box{border:1px solid var(--border);border-radius:var(--r);background:var(--bg);margin:0 0 16px;overflow:hidden}
.box>.head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg2);border-bottom:1px solid var(--border);flex-wrap:wrap}
.box>.body{padding:14px}
.box>.head h2,.box>.head h3{margin:0;font-size:14px;display:inline-flex;align-items:center;gap:6px}
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-top:1px solid var(--border2)}
.list>li:first-child{border-top:0}.list>li:hover{background:var(--bg2)}
.list>li>.st:first-child,.list>li>svg:first-child{margin-top:2px}
.list .title{font-weight:600;color:var(--fg)}.list .title:hover{color:var(--accent)}
.list .meta{font-size:12px;color:var(--fg2);margin-top:2px}
.empty{padding:32px 16px;text-align:center;color:var(--fg2)}
.blank{border:1px dashed var(--border);border-radius:var(--r);padding:32px;text-align:center;color:var(--fg2)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:1px solid var(--border);border-radius:999px;font-size:12px;font-weight:500;color:var(--fg2);line-height:18px;white-space:nowrap;vertical-align:middle}
.badge.agent{border-color:color-mix(in srgb,var(--purple) 45%,transparent);color:var(--purple);background:var(--purple-soft)}
.badge.green{border-color:transparent;background:var(--green-soft);color:var(--green)}
.badge.red{border-color:transparent;background:var(--red-soft);color:var(--red)}
.badge.amber{border-color:transparent;background:var(--amber-soft);color:var(--amber)}
.badge.purple{border-color:transparent;background:var(--purple-soft);color:var(--purple)}
.badge.blue{border-color:transparent;background:var(--blue-soft);color:var(--blue)}
.state{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-weight:600;font-size:13px;color:#fff}
.state.open{background:var(--green)}.state.closed{background:var(--red)}.state.merged{background:var(--purple)}.state.draft{background:var(--fg3)}
.lbl{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;font-weight:550;line-height:20px;background:color-mix(in srgb,var(--lc) 18%,transparent);color:color-mix(in srgb,var(--lc) 70%,var(--fg));border:1px solid color-mix(in srgb,var(--lc) 40%,transparent);margin-right:4px}
.av{display:inline-block;width:20px;height:20px;border-radius:50%;flex:none;vertical-align:middle;object-fit:cover;background:var(--bg3);outline:1px solid var(--border);outline-offset:-1px}
.av.lg{width:40px;height:40px}.av.xl{width:96px;height:96px}.av.bot{border-radius:6px}.av.xl.bot{border-radius:16px}
input[type=file]{max-width:100%;font:13px/1.4 var(--sans);color:var(--fg2)}
input[type=file]::file-selector-button{margin-right:10px;padding:6px 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg);color:var(--fg);font:500 13px/1.4 var(--sans);cursor:pointer}
input[type=file]::file-selector-button:hover{background:var(--bg-hover);border-color:var(--fg3)}
.avpick{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.avpick .grow{min-width:240px}
.avpick [data-avatar-status]:empty{display:none}
.who{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--fg)}.top .who{white-space:nowrap}
.repohead{padding:18px 0 0;border-bottom:1px solid var(--border);background:var(--bg2)}
.repohead h1{font-size:19px;font-weight:500;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 6px}
.repohead h1 a{color:var(--fg)}.repohead h1 strong a{font-weight:650}
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;margin-top:10px}
.tabs a{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;color:var(--fg2);border-bottom:2px solid transparent;white-space:nowrap}
.tabs a:hover{color:var(--fg);text-decoration:none;border-bottom-color:var(--border)}
.tabs a.on{color:var(--fg);font-weight:600;border-bottom-color:var(--accent)}
.tabs .n{background:var(--bg3);border-radius:999px;padding:0 7px;font-size:12px;color:var(--fg2)}
.subnav{display:flex;gap:0;border:1px solid var(--border);border-radius:7px;overflow:hidden;width:max-content;max-width:100%}
.subnav a{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;color:var(--fg2);border-left:1px solid var(--border)}.subnav a:first-child{border-left:0}
.subnav a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}.subnav a:hover{text-decoration:none;background:var(--bg-hover)}
.side .nav h4{font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.04em;margin:14px 10px 4px}
.side h3{font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px}
.side section{padding:0 0 16px;margin:0 0 16px;border-bottom:1px solid var(--border2)}
.side .nav a{display:block;padding:6px 10px;border-radius:6px;color:var(--fg)}.side .nav a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}.side .nav a:hover{background:var(--bg-hover);text-decoration:none}
details.menu{position:relative;display:inline-block}
details.menu>summary{list-style:none;cursor:pointer}details.menu>summary::-webkit-details-marker{display:none}
details.menu>.pop{position:absolute;z-index:30;top:calc(100% + 4px);left:0;min-width:260px;max-height:360px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);padding:6px}
details.menu>.pop.right{left:auto;right:0}
details.menu .pop a{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:5px;color:var(--fg)}details.menu .pop a:hover{background:var(--bg-hover);text-decoration:none}
details.menu .pop button.mi{display:flex;width:100%;gap:8px;align-items:center;padding:6px 8px;border:0;border-radius:5px;background:none;color:var(--fg);font:inherit;text-align:left;cursor:pointer}details.menu .pop button.mi:hover{background:var(--bg-hover)}
details.minimized>summary{cursor:pointer;padding:8px 12px;list-style:none}details.minimized>summary::-webkit-details-marker{display:none}details.minimized>summary .small{color:var(--accent)}details.minimized[open]>summary .small{display:none}
details.menu .pop h4{font-size:11px;text-transform:uppercase;color:var(--fg3);margin:6px 8px 4px}
.crumbs{font-size:15px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}.crumbs a{font-weight:600}
table.files{width:100%;border-collapse:collapse}
table.files td{padding:7px 14px;border-top:1px solid var(--border2)}table.files tr:first-child td{border-top:0}
table.files tr:hover td{background:var(--bg2)}table.files td.ic{width:20px;padding-right:0;color:var(--fg3)}
table.files td.sz{text-align:right;color:var(--fg2);width:100px;white-space:nowrap}
table.files a{color:var(--fg)}table.files a:hover{color:var(--accent)}
.ic-dir{color:var(--accent)!important}
.clone{display:flex;gap:6px;align-items:center}
.clone input{font-family:var(--mono);font-size:12px}
.openin{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}
pre.cmd{background:var(--code-bg);border:1px solid var(--border2);border-radius:7px;padding:12px 14px;overflow:auto;margin:0 0 12px}
pre.cmd.one{padding:7px 12px;line-height:20px;margin:0;white-space:pre-wrap;word-break:break-all}
.code-wrap{overflow:auto}
table.blob{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12.5px;line-height:20px}
table.blob td{padding:0 12px;vertical-align:top;white-space:pre}
table.blob td.ln{width:1%;min-width:50px;text-align:right;color:var(--fg3);user-select:none;padding-right:10px}
table.blob td.ln a{color:inherit}table.blob tr:target td{background:var(--hl)}
table.diff{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12px;line-height:20px}
table.diff td{padding:0 8px;vertical-align:top}
table.diff td.ln{width:1%;min-width:44px;text-align:right;color:var(--fg3);user-select:none;white-space:nowrap}
table.diff td.code{white-space:pre-wrap;word-break:break-all;width:100%}
table.diff tr.add td{background:var(--add-bg)}table.diff tr.add td.ln{background:var(--add-ln)}
table.diff tr.del td{background:var(--del-bg)}table.diff tr.del td.ln{background:var(--del-ln)}
table.diff tr.hunk td{background:var(--hunk-bg);color:var(--fg2);padding-top:2px;padding-bottom:2px}
table.diff tr.meta td{color:var(--fg3);font-style:italic}
table.diff td.act{width:1%;padding:0 2px}
table.diff .addc{visibility:hidden;border:0;background:var(--accent);color:#fff;border-radius:4px;width:18px;height:18px;line-height:16px;cursor:pointer;font-weight:700;padding:0}
table.diff tr:hover .addc{visibility:visible}
table.diff tr.thread td{background:var(--bg2);padding:8px 12px;font-family:var(--sans);font-size:14px;white-space:normal}
/* Shiki tokens carry both GitHub themes as custom properties; untokened text keeps the site's color. */
.sh>span{color:var(--shiki-light);font-style:var(--shiki-light-font-style);font-weight:var(--shiki-light-font-weight);text-decoration:var(--shiki-light-text-decoration)}
:root[data-theme=dark] .sh>span{color:var(--shiki-dark);font-style:var(--shiki-dark-font-style);font-weight:var(--shiki-dark-font-weight);text-decoration:var(--shiki-dark-text-decoration)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .sh>span{color:var(--shiki-dark);font-style:var(--shiki-dark-font-style);font-weight:var(--shiki-dark-font-weight);text-decoration:var(--shiki-dark-text-decoration)}}
.filehead{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border-bottom:1px solid var(--border);cursor:pointer;position:sticky;top:52px;z-index:5;flex-wrap:wrap}
details.file{border:1px solid var(--border);border-radius:var(--r);margin:0 0 14px;overflow:clip}
details.file>summary{list-style:none}details.file>summary::-webkit-details-marker{display:none}
details.file:not([open])>.filehead{border-bottom:0}
.stat-add{color:var(--green);font-weight:600}.stat-del{color:var(--red);font-weight:600}
.bar{display:inline-flex;gap:1px;vertical-align:middle}.bar i{width:8px;height:8px;border-radius:1px;background:var(--bg3)}.bar i.a{background:var(--green)}.bar i.d{background:var(--red)}
.comment{border:1px solid var(--border);border-radius:var(--r);margin:0 0 16px;background:var(--bg)}
.comment>.head{display:flex;gap:8px;align-items:center;padding:8px 14px;background:var(--bg2);border-bottom:1px solid var(--border);border-radius:var(--r) var(--r) 0 0;flex-wrap:wrap;font-size:13px}
.comment>.body{padding:14px}
.comment.intent{border-color:color-mix(in srgb,var(--accent) 45%,transparent)}.comment.intent>.head{background:var(--accent-soft)}
.timeline{position:relative}
.event{display:flex;gap:10px;align-items:center;padding:6px 0 6px 14px;margin:0 0 16px;color:var(--fg2);font-size:13px}
.event .ic{display:inline-flex;width:28px;height:28px;border-radius:50%;align-items:center;justify-content:center;background:var(--bg3);flex:none}
.event.approved .ic{background:var(--green-soft);color:var(--green)}.event.changes .ic{background:var(--red-soft);color:var(--red)}
.linec{border-left:3px solid var(--border);padding:6px 10px;margin:8px 0;background:var(--bg2);border-radius:0 6px 6px 0}
.linec .where{font-family:var(--mono);font-size:12px;color:var(--fg2)}
.mergebox{border:1px solid var(--border);border-radius:var(--r);margin:0 0 16px;overflow:hidden}
.mergebox>div{padding:12px 14px;border-top:1px solid var(--border2)}.mergebox>div:first-child{border-top:0}
.mergebox.clean{border-color:color-mix(in srgb,var(--green) 50%,transparent)}.mergebox.blocked,.mergebox.conflicting{border-color:color-mix(in srgb,var(--amber) 55%,transparent)}
.mergebox.merged{border-color:color-mix(in srgb,var(--purple) 50%,transparent)}
.checks{list-style:none;margin:0;padding:0}.checks li{display:flex;gap:8px;align-items:center;padding:4px 0}
.st{display:inline-flex;width:16px;height:16px;flex:none;align-items:center;justify-content:center}
.st svg{width:16px;height:16px}
.st.spin svg{animation:spin 1.1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.job{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--border2);color:var(--fg)}
.job:hover{background:var(--bg2);text-decoration:none}.job:first-of-type{border-top:0}
.jobgroup{margin:0 0 16px}
.failure{border:1px solid color-mix(in srgb,var(--red) 45%,transparent);background:var(--red-soft);border-radius:var(--r);padding:12px 14px;margin:0 0 16px}
.failure pre{white-space:pre-wrap;margin:6px 0 0;color:var(--fg)}
.log{background:#0d1014;color:#d5d9de;border-radius:var(--r);overflow:hidden;margin:0 0 16px;border:1px solid var(--border)}
.log details{border-top:1px solid #1d2229}.log details:first-child{border-top:0}
.log summary{display:flex;gap:10px;align-items:center;padding:8px 14px;cursor:pointer;list-style:none;color:#e6e8eb}
.log summary::-webkit-details-marker{display:none}.log summary:hover{background:#151a20}
.log summary .dur{margin-left:auto;color:#7f8792;font-size:12px}
.log pre{margin:0;padding:6px 0 10px;overflow:auto;font-size:12px;line-height:19px;counter-reset:l}
.log pre span{display:block;padding:0 14px 0 64px;position:relative;white-space:pre-wrap;word-break:break-all;min-height:19px}
.log pre span::before{counter-increment:l;content:counter(l);position:absolute;left:0;width:48px;text-align:right;color:#59616c}
.log pre span.grp{color:#8fb3ff;font-weight:600}.log pre span.err{color:#ff8c84}.log pre span.wrn{color:#e5c07b}
.markdown{line-height:1.65;word-wrap:break-word}
.markdown>*:first-child{margin-top:0}.markdown>*:last-child{margin-bottom:0}
.markdown h1,.markdown h2{padding-bottom:6px;border-bottom:1px solid var(--border2);margin:22px 0 12px}
.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:18px 0 8px}
.markdown h1 .anchor,.markdown h2 .anchor,.markdown h3 .anchor,.markdown h4 .anchor,.markdown h5 .anchor,.markdown h6 .anchor{float:left;margin-left:-18px;padding-right:4px;opacity:0;color:var(--fg3)}
.markdown :is(h1,h2,h3,h4,h5,h6):hover .anchor{opacity:1}
.markdown p,.markdown ul,.markdown ol,.markdown blockquote,.markdown pre,.markdown .table-wrap{margin:0 0 14px}
.markdown ul,.markdown ol{padding-left:2em}.markdown li+li{margin-top:3px}.markdown li.task{list-style:none;margin-left:-1.4em}
.markdown code{background:var(--code-bg);padding:.15em .4em;border-radius:5px;font-size:85%}
.markdown pre{background:var(--code-bg);padding:14px;border-radius:7px;overflow:auto;line-height:1.45;border:1px solid var(--border2)}
.markdown pre code{background:none;padding:0;font-size:12.5px}
.markdown blockquote{padding:0 1em;color:var(--fg2);border-left:3px solid var(--border)}
.markdown img{max-width:100%}.markdown hr{height:2px;background:var(--border2);border:0}
.markdown .markdown-alert{margin:0 0 14px;padding:8px 14px;border-left:3px solid var(--a);border-radius:0 6px 6px 0;background:var(--as)}
.markdown .markdown-alert>:last-child{margin-bottom:0}.markdown .markdown-alert-title{font-weight:600;color:var(--a);margin:0 0 4px}
.markdown-alert-note{--a:var(--blue);--as:var(--blue-soft)}.markdown-alert-tip{--a:var(--green);--as:var(--green-soft)}.markdown-alert-important{--a:var(--purple);--as:var(--purple-soft)}
.markdown-alert-warning{--a:var(--amber);--as:var(--amber-soft)}.markdown-alert-caution{--a:var(--red);--as:var(--red-soft)}
.markdown .table-wrap{overflow:auto}.markdown table{border-collapse:collapse}
.markdown th,.markdown td{border:1px solid var(--border);padding:6px 12px}.markdown th{background:var(--bg2);font-weight:600}
.readme{margin-top:16px}.readme>.body{padding:24px 32px}
@media (max-width:700px){.readme>.body{padding:16px}.wrap{padding:0 12px}}
dialog#palette{border:1px solid var(--border);border-radius:12px;padding:0;width:min(640px,94vw);background:var(--bg);color:var(--fg);box-shadow:var(--shadow);margin-top:12vh}
dialog#palette::backdrop{background:rgba(10,12,16,.45)}
#palette input{border:0;border-bottom:1px solid var(--border);border-radius:0;padding:14px 16px;font-size:15px;outline:none}
#palette ul{list-style:none;margin:0;padding:6px;max-height:min(420px,60vh);overflow:auto}
#palette li a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;color:var(--fg)}
#palette li a span{margin-left:auto;color:var(--fg3);font-size:12px}
#palette li.sel a,#palette li a:hover{background:var(--accent-soft);text-decoration:none}
#palette .foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--border);font-size:12px;color:var(--fg3)}
.hero{padding:72px 0 40px;text-align:center}
.hero h1{font-size:44px;letter-spacing:-.03em;margin:0 0 14px}
.hero p{font-size:18px;color:var(--fg2);max-width:640px;margin:0 auto 26px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin:24px 0}
.features .box{padding:18px}.features h3{margin:0 0 6px}
/* Early access (web/early-access.tsx): the request form, its result pages and the admin list. */
.ea-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--link);background:var(--accent-soft);border-radius:999px;padding:3px 12px;margin:0 0 16px}
a.ea-eyebrow:hover{text-decoration:none;filter:brightness(1.08)}
.ea{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);grid-template-areas:"head card" "more card";column-gap:56px;align-items:start;max-width:1040px;margin:48px auto 24px}
.ea-head{grid-area:head}.ea-more{grid-area:more}.ea-card{grid-area:card}
.ea h1{font-size:36px;letter-spacing:-.025em;margin:0 0 12px}
.ea-lede{font-size:16px;color:var(--fg2);margin:0 0 28px;max-width:520px}
.ea-points{list-style:none;padding:0;margin:0 0 28px;display:grid;gap:16px}
.ea-points li{display:flex;gap:12px;align-items:flex-start}
.ea-points li>span:last-child{display:flex;flex-direction:column;gap:2px}
.ea-points .ic{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--bg);border:1px solid var(--border);color:var(--fg)}
.ea-steps{counter-reset:s;list-style:none;margin:0;display:grid;gap:10px;border-top:1px solid var(--border2);padding:20px 0 0}
.ea-steps li{counter-increment:s;display:flex;gap:10px;align-items:center;color:var(--fg2)}
.ea-steps li::before{content:counter(s);flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:var(--bg3);color:var(--fg);font-size:12px;font-weight:600}
.ea-card{border:0;box-shadow:var(--shadow)}
.ea-card .body{padding:26px}
.ea-card h2{margin:0 0 2px}
.ea-card textarea,.ea-card input[type=email],.ea-card input[type=text]{width:100%}
.ea-hp{position:absolute!important;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}
.ea-privacy{font-size:12px;color:var(--fg2);margin:14px 0 0}
.ea-done{max-width:580px;margin:64px auto;text-align:center}
.ea-done>p{font-size:15px}
.ea-done .ic{display:inline-grid;place-items:center;width:60px;height:60px;border-radius:999px;background:var(--accent-soft);color:var(--link);margin:0 0 18px}
.ea-done .ic svg{width:28px;height:28px}
.ea-done form{margin-top:18px}
.ea-av{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:999px;background:var(--accent-soft);color:var(--link);font-weight:600;font-size:14px}
.ea-av.lg{width:48px;height:48px;font-size:20px}
.ea-use{margin-top:6px;color:var(--fg);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ea-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
@media (max-width:900px){.ea{grid-template-columns:1fr;grid-template-areas:"head" "card" "more";row-gap:24px;margin-top:24px}.ea h1{font-size:28px}.ea-list>li{flex-wrap:wrap}.ea-actions{width:100%;justify-content:flex-start;padding-left:42px}}
.stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--fg2);font-size:13px}
.stats b{color:var(--fg)}
.tx{display:flex;flex-direction:column;gap:10px}.tx .markdown{margin:0}
.tx-run{margin:8px 0 0;padding-top:8px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}.tx-run:first-child{border-top:0;padding-top:0;margin-top:0}
.tx-note{padding-left:10px;border-left:2px solid var(--border)}
.tx-result{padding:10px 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--subtle,transparent)}
.tx-tool summary{cursor:pointer;color:var(--muted)}.tx-tool[open] summary{margin-bottom:6px}
.term{height:min(70vh,760px);min-height:320px;padding:8px;background:#111113;border:1px solid var(--border);border-radius:var(--r);overflow:hidden}.term .xterm{height:100%}
.term-status[data-tone=ok]{color:var(--green)}.term-status[data-tone=warn]{color:var(--amber)}
.tx-pre{margin:0;padding:8px 10px;background:#0d1014;color:#d5d9de;border-radius:var(--r);font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto}
.tx-err{border-left:3px solid var(--red)}
.today-sec>summary{list-style:none;cursor:pointer;user-select:none}.today-sec>summary::-webkit-details-marker{display:none}
.today-sec>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.today-sec:not([open])>summary{border-bottom:0}
.today-sec>summary .tog{display:inline-flex;color:var(--fg2);transition:transform .15s}.today-sec:not([open])>summary .tog{transform:rotate(-90deg)}
.today-sec>summary .count{font:600 12px/18px var(--sans);padding:0 7px;border-radius:999px;background:var(--bg-hover);color:var(--fg2)}
.today-sec>summary .manage{margin-left:auto}
@media (max-width:640px){.today-sec>summary .note{flex-basis:100%;order:9}.today-sec:not([open])>summary .note{display:none}}
.today-more>summary{list-style:none;padding:8px 14px;border-top:1px solid var(--border2)}.today-more>summary::-webkit-details-marker{display:none}
.today-more>summary .btn svg{width:12px;height:12px}.today-more[open]>summary{display:none}
.today-more>.list>li:first-child{border-top:1px solid var(--border2)}.today-more>.fewer{padding:8px 14px;border-top:1px solid var(--border2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 16px}
.tile{display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;background:var(--bg);color:var(--fg);text-decoration:none}
.tile:hover{border-color:var(--accent);text-decoration:none}
.tile .num{font-size:24px;font-weight:600;line-height:1.2}
.tile .lbl{font-size:12px;color:var(--fg2)}
.tile.purple .num{color:var(--purple)}
.tile.red .num{color:var(--red)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px}.kv dt{color:var(--fg2)}.kv dd{margin:0}
table.tbl{width:100%;border-collapse:collapse;font-size:13px}
table.tbl th{text-align:left;font-weight:600;color:var(--fg2);padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg2);white-space:nowrap}
table.tbl td{padding:8px 12px;border-top:1px solid var(--border2);vertical-align:middle}
table.tbl th.r,table.tbl td.r{text-align:right;font-variant-numeric:tabular-nums}
.xscroll{overflow-x:auto}
.secret{font-family:var(--mono);background:var(--amber-soft);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);border-radius:var(--r);padding:7px 12px;line-height:20px;min-height:36px;word-break:break-all}
.connect-url{font-family:var(--mono);background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:7px 12px;line-height:20px;min-height:36px;word-break:break-all;font-size:13px}.connect-ai{border-bottom:1px solid var(--border2)}
.pager{display:flex;gap:8px;justify-content:center;margin:16px 0}
.sha{font-family:var(--mono);font-size:12px;padding:1px 6px;border-radius:5px;background:var(--bg3);color:var(--fg)}
/* Buttons joined into one control (copy · sha · browse). */
.btngroup{display:inline-flex;flex:none}.btngroup>.btn{border-radius:0;margin-left:-1px}.btngroup>.btn:first-child{border-radius:var(--r-sm) 0 0 var(--r-sm);margin-left:0}.btngroup>.btn:last-child{border-radius:0 var(--r-sm) var(--r-sm) 0}.btngroup>.btn:hover{position:relative;z-index:1}
.btn.mono{font-family:var(--mono)}
a.sha:hover{text-decoration:none;background:var(--accent-soft);color:var(--accent)}
.right{text-align:right}.mt{margin-top:16px}.mb{margin-bottom:16px}.m0{margin:0}
form.inline{display:inline}
.navbtn{background:none;border:0;color:var(--fg2);padding:6px 10px;border-radius:6px;font:inherit;cursor:pointer;white-space:nowrap}.navbtn:hover{background:var(--bg-hover);color:var(--fg)}
.btn.block{display:flex;width:100%;justify-content:center}
.authcard{max-width:440px;margin:56px auto}.authcard .body{padding:28px}.authcard h1{font-size:24px;margin:12px 0 8px}
.usercode{font-family:var(--mono);font-size:18px;font-weight:600;letter-spacing:.12em;padding:2px 8px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg2);white-space:nowrap}
.usercode-input{font-family:var(--mono);font-size:20px;letter-spacing:.14em;text-transform:uppercase;text-align:center}
.authmark{width:44px;height:44px;border-radius:var(--r);display:grid;place-items:center;background:color-mix(in srgb,var(--brand) 14%,transparent);color:var(--brand)}.authmark svg{width:22px;height:22px}
.authfoot{margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}.authfoot p{margin:0 0 6px}
.kstack{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin:0 0 8px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.task-box{display:inline-block;width:14px;height:14px;margin:0 4px -2px 0;border-radius:4px;box-shadow:inset 0 0 0 1px var(--border);background:var(--bg)}
.task-box.on{background:var(--fg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Cpath fill='white' d='M232.49 80.49l-128 128a12 12 0 0 1-17 0l-56-56a12 12 0 1 1 17-17L96 183 215.51 63.51a12 12 0 0 1 17 17Z'/%3E%3C/svg%3E") center/10px no-repeat;box-shadow:none}
${dark(".task-box.on", "filter:invert(1)")}
}
@layer kumo-reset{.dfy-k,.dfy-k :not(svg,svg *){all:revert}}
@layer islands{
.dfy-k{display:inline-block;vertical-align:middle;font:14px/1.5 var(--sans);color:var(--fg);text-align:left;font-weight:400}
.dfy-k.block{display:block}.dfy-k.block .dfy-k-select{display:block}
.dfy-k-select{display:inline-block}
.dfy-k-portal{display:block}
.dfy-k.block [data-kumo-part=trigger]{width:100%}
.dfy-k-desc{display:block;color:var(--fg2);font-size:12px;font-weight:400}.dfy-k-lbl{display:block}
.dfy-k-html .muted{color:var(--fg2)}.dfy-k-html .small{font-size:12px}.dfy-k-html .mono,.dfy-k-html code{font-family:var(--mono);font-size:12.5px}
.dfy-k-html .ok{color:var(--green)}.dfy-k-html .bad{color:var(--red)}
.dfy-k-html .lbl{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;font-weight:550;line-height:20px;background:color-mix(in srgb,var(--lc) 18%,transparent);color:color-mix(in srgb,var(--lc) 70%,var(--fg));border:1px solid color-mix(in srgb,var(--lc) 40%,transparent)}
.dfy-k-html code{background:var(--code-bg);padding:1px 5px;border-radius:4px}
.kf-select{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-width:120px;height:36px;padding:0 12px;border-radius:8px;background:var(--bg);box-shadow:0 0 0 1px var(--border);color:var(--fg);white-space:nowrap}
.kf-select.sm{height:26px;padding:0 8px;border-radius:6px;font-size:12px;min-width:90px}.kf-select.xs{height:20px;padding:0 6px;border-radius:4px;font-size:12px;min-width:70px}
.dfy-k.block .kf-select{display:flex;width:100%}
.kf-select svg{color:var(--fg3);flex:none}.kf-ph{color:var(--fg3)}
.kf-check{display:inline-flex;align-items:flex-start;gap:8px}
.kf-box,.kf-dot{width:16px;height:16px;margin-top:2px;flex:none;box-shadow:0 0 0 1px var(--border);background:var(--bg)}
.kf-box{border-radius:4px}.kf-box.on{background:var(--fg);box-shadow:none}
.kf-dot{border-radius:50%}.kf-dot.on{box-shadow:inset 0 0 0 5px var(--fg)}
.kf-radio{display:flex;flex-direction:column;gap:8px}.kf-radio.horizontal{flex-direction:row;gap:16px;flex-wrap:wrap}
.kf-desc{display:block;color:var(--fg2);font-size:12px}
.theme-opt{display:flex;align-items:center;gap:8px}
.theme-prev{display:inline-flex;flex-direction:column;justify-content:center;gap:2px;width:30px;height:20px;padding:0 5px;border-radius:4px;box-shadow:0 0 0 1px var(--border);flex:none}
.theme-prev i{display:block;height:2px;border-radius:2px;background:#a1a1aa}.theme-prev i:first-child{width:55%;background:oklch(48.8% 0.243 264.376)}.theme-prev i:last-child{width:75%}
.theme-prev.light{background:#fff}.theme-prev.light i:not(:first-child){background:#d4d4d8}
.theme-prev.dark{background:#1c1c1e}.theme-prev.dark i:not(:first-child){background:#52525b}
.theme-prev.auto{background:linear-gradient(135deg,#fff 50%,#1c1c1e 50%)}
}
/* Page changes: a cross-document view transition under 100 ms. The header, repository header, organization
   tabs and settings menu keep their place and swap instantly; only the page content fades. Browsers without support, and people
   who ask for reduced motion, just navigate. */
@media (prefers-reduced-motion:no-preference){
@view-transition{navigation:auto}
header.top{view-transition-name:dfy-top}
.repohead{view-transition-name:dfy-repohead}
main.wrap{view-transition-name:dfy-main}
.vt-tabs{view-transition-name:dfy-tabs}
.vt-side{view-transition-name:dfy-side}
::view-transition-group(*){animation-duration:70ms;animation-timing-function:ease-out}
::view-transition-old(dfy-top),::view-transition-new(dfy-top),::view-transition-old(dfy-repohead),::view-transition-new(dfy-repohead),
::view-transition-old(dfy-tabs),::view-transition-new(dfy-tabs),::view-transition-old(dfy-side),::view-transition-new(dfy-side){animation:none}
::view-transition-old(root),::view-transition-old(dfy-main){animation:70ms ease-out both dfy-vt-out}
::view-transition-new(root),::view-transition-new(dfy-main){animation:70ms ease-out both dfy-vt-in}
@keyframes dfy-vt-out{to{opacity:0}}
@keyframes dfy-vt-in{from{opacity:0;transform:translateY(3px)}}
}
`;

/** Client behaviour: palette, shortcuts, copy buttons, live updates, line comments. */
export const JS = `(()=>{
const d=document,b=d.body,$=(s,r=d)=>r.querySelector(s),$$=(s,r=d)=>[...r.querySelectorAll(s)];
const repo=b.dataset.repo||'',ref=b.dataset.ref||'';
const enc=p=>p.split('/').map(encodeURIComponent).join('/');
// Fields that want the browser's time zone (the morning digest's "this browser" choice).
$$('input[data-browser-tz]').forEach(i=>{try{i.value=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(_){}});
// Today's sections (agentic/web.tsx): remember which are folded away, open one a link points at, fold "Show N more" back.
const todaySecs=$$('details[data-today-sec]');
const saveTodaySecs=()=>{d.cookie='today_collapsed='+todaySecs.filter(x=>!x.open).map(x=>x.dataset.todaySec).join('.')+';path=/;max-age=31536000;samesite=lax'+(location.protocol==='https:'?';secure':'')};
todaySecs.forEach(x=>x.addEventListener('toggle',saveTodaySecs));
const openTodaySec=()=>{const x=location.hash&&todaySecs.find(s=>'#'+s.id===location.hash);if(x&&!x.open)x.open=true};
openTodaySec();window.addEventListener('hashchange',openTodaySec);
$$('.today-more>.fewer').forEach(x=>{x.hidden=false});
d.addEventListener('click',e=>{
  const fewer=e.target.closest('[data-show-fewer]');
  if(fewer){const m=fewer.closest('details');m.open=false;const s=$('summary',m);s.focus({preventScroll:true});s.scrollIntoView({block:'nearest'});return}
  const toSec=e.target.closest('a[href^="#"]');if(toSec){const x=todaySecs.find(s=>'#'+s.id===toSec.getAttribute('href'));if(x)x.open=true}
  const c=e.target.closest('[data-copy]');
  if(c){e.preventDefault();const v=c.dataset.copy;(navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(()=>{const o=c.innerHTML;if(c.dataset.copyIcon)c.innerHTML=${JSON.stringify(UI_ICONS.check)};else c.textContent='Copied';setTimeout(()=>{c.innerHTML=o},1200)}).catch(()=>{window.prompt('Copy:',v)});return}
  const p=e.target.closest('[data-palette]');if(p){e.preventDefault();openPalette();return}
  const a=e.target.closest('[data-comment-line]');if(a){e.preventDefault();lineComment(a);return}
  const x=e.target.closest('[data-cancel-line]');if(x){e.preventDefault();const tr=x.closest('tr');tr&&tr.remove()}
  if(!e.target.closest('details.menu'))$$('details.menu[open]').forEach(m=>m.removeAttribute('open'));
});
d.addEventListener('submit',e=>{const f=e.target;if(f.dataset.passkey){e.preventDefault();passkey(f);return}
  if(f.dataset.confirm&&!confirm(f.dataset.confirm)){e.preventDefault();return}
  if(f.dataset.match){const i=f.querySelector('[name=confirm]');if(i&&i.value!==f.dataset.match){e.preventDefault();alert('Type '+f.dataset.match+' to confirm.');return}}
  $$('button[type=submit],button:not([type])',f).forEach(x=>setTimeout(()=>{x.disabled=true},0));},true);
// Passkeys (WebAuthn): forms with data-passkey="login" or "register"
const b2u=buf=>{let s='';new Uint8Array(buf).forEach(x=>{s+=String.fromCharCode(x)});return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')};
const u2b=s=>{s=s.replaceAll('-','+').replaceAll('_','/');while(s.length%4)s+='=';const bin=atob(s);const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out.buffer};
async function pkPost(url,body){const r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let j={};try{j=await r.json()}catch(_){}if(!r.ok&&j.confirm){location.assign(j.confirm);await new Promise(()=>{})}if(!r.ok)throw new Error(j.message||('Request failed ('+r.status+')'));return j}
async function passkey(f){const mode=f.dataset.passkey,msg=$('[data-passkey-msg]',f)||$('[data-passkey-msg]'),btns=$$('button',f);
  const show=t=>{if(msg){msg.textContent=t;msg.hidden=!t}else if(t)alert(t)};
  if(!window.PublicKeyCredential||!navigator.credentials){show('This browser does not support passkeys. Try a current version of Chrome, Safari, Edge or Firefox.');return}
  show('');btns.forEach(x=>{x.disabled=true});
  const data={};new FormData(f).forEach((v,k)=>{if(typeof v==='string')data[k]=v});data.next=f.dataset.next||'/';
  try{const o=await pkPost('/auth/passkey/'+mode+'/options',data);o.challenge=u2b(o.challenge);let cred,res;
    if(mode==='login'){(o.allowCredentials||[]).forEach(c=>{c.id=u2b(c.id)});cred=await navigator.credentials.get({publicKey:o});const r=cred.response;
      res={authenticatorData:b2u(r.authenticatorData),clientDataJSON:b2u(r.clientDataJSON),signature:b2u(r.signature)};if(r.userHandle)res.userHandle=b2u(r.userHandle)}
    else{o.user.id=u2b(o.user.id);(o.excludeCredentials||[]).forEach(c=>{c.id=u2b(c.id)});cred=await navigator.credentials.create({publicKey:o});const r=cred.response;
      res={attestationObject:b2u(r.attestationObject),clientDataJSON:b2u(r.clientDataJSON),transports:r.getTransports?r.getTransports():[]}}
    const v=await pkPost('/auth/passkey/'+mode+'/verify',Object.assign({},data,{response:{id:cred.id,rawId:b2u(cred.rawId),type:cred.type,response:res,clientExtensionResults:cred.getClientExtensionResults(),authenticatorAttachment:cred.authenticatorAttachment||undefined}}));
    location.assign(v.redirect||'/')}
  catch(e){btns.forEach(x=>{x.disabled=false});
    show(e&&e.name==='NotAllowedError'?'The passkey prompt was closed or timed out. Try again when you are ready.':e&&e.name==='InvalidStateError'?'This device already has a passkey for this account.':(e&&e.message)||String(e))}}
function lineComment(btn){
  const tpl=$('#line-comment-tpl');if(!tpl)return;
  const tr=btn.closest('tr');const next=tr.nextElementSibling;
  if(next&&next.classList.contains('newc')){next.querySelector('textarea').focus();return}
  const row=d.createElement('tr');row.className='thread newc';const td=d.createElement('td');td.colSpan=tr.children.length;
  td.append(tpl.content.cloneNode(true));row.append(td);tr.after(row);
  row.querySelector('[name=path]').value=btn.dataset.path;row.querySelector('[name=line]').value=btn.dataset.commentLine;
  row.querySelector('[name=side]').value=btn.dataset.side||'RIGHT';row.querySelector('.where').textContent=btn.dataset.path+':'+btn.dataset.commentLine;
  row.querySelector('textarea').focus();
}
// Profile pictures: preview the centred square, then upload it at most 512 px wide (the server makes the small WebPs).
// Files this browser cannot decode (HEIC in Chrome, say) go up as they are; the server's answer comes back as the flash message.
let webpOk=null;
async function squareBlob(file){const bmp=await createImageBitmap(file);const side=Math.min(bmp.width,bmp.height),out=Math.min(512,side);
  const cv=d.createElement('canvas');cv.width=cv.height=out;const ctx=cv.getContext('2d');ctx.imageSmoothingQuality='high';
  ctx.drawImage(bmp,(bmp.width-side)/2,(bmp.height-side)/2,side,side,0,0,out,out);if(bmp.close)bmp.close();
  if(webpOk===null){const t=d.createElement('canvas');t.width=t.height=1;webpOk=t.toDataURL('image/webp').startsWith('data:image/webp')}
  return new Promise((ok,no)=>cv.toBlob(x=>x?ok(x):no(new Error('encode failed')),webpOk?'image/webp':'image/png',0.92))}
$$('form[data-avatar]').forEach(f=>{const inp=$('input[type=file]',f),st=$('[data-avatar-status]',f),box=f.closest('.avpick')||d,img=$('[data-avatar-preview] img',box);
  if(!inp)return;let blob=null,url='';const orig=img&&img.getAttribute('src');const say=t=>{if(st)st.textContent=t};
  inp.addEventListener('change',async()=>{blob=null;if(url){URL.revokeObjectURL(url);url=''}const file=inp.files&&inp.files[0];
    if(!file){if(img&&orig)img.src=orig;say('');return}
    try{blob=await squareBlob(file);url=URL.createObjectURL(blob);if(img){img.loading='eager';img.src=url}say('Preview. Save to use this picture.')}
    catch(_){blob=null;if(img&&orig)img.src=orig;say('No preview for this file; it will be checked when you save.')}});
  f.addEventListener('submit',async e=>{const file=inp.files&&inp.files[0];if(e.defaultPrevented||!file)return;e.preventDefault();
    const fd=new FormData(f);if(blob)fd.set(inp.name,blob,blob.type==='image/webp'?'avatar.webp':'avatar.png');
    say('Uploading…');$$('button',f).forEach(x=>{x.disabled=true});
    // The answer is a redirect that sets the flash message; follow it by reloading the page.
    try{await fetch(f.action,{method:'POST',body:fd,credentials:'same-origin',redirect:'manual'})}catch(_){}
    location.reload()})});
// Palette
const dlg=$('#palette'),inp=dlg&&$('input',dlg),ul=dlg&&$('ul',dlg);let items=null,shown=[],sel=0,loading=false;
function base(){const a=[['Dashboard','/'],['New repository','/new'],['Notifications','/notifications'],['Settings','/settings'],['Tokens','/settings/tokens'],['Agents','/settings/agents']].map(([t,u])=>({t,u,k:'Go to'}));
  if(repo){const r='/'+repo;[['Code',''],['Issues','/issues'],['New issue','/issues/new'],['Pull requests','/pulls'],['Actions','/actions'],['Branches','/branches'],['Tags','/tags'],['Commits','/commits/'+enc(ref||'HEAD')],['Compare','/compare'],['Settings','/settings']].forEach(([t,p])=>a.unshift({t:repo+' › '+t,u:r+p,k:'Repository'}))}
  return a}
async function load(){if(items||loading)return;loading=true;items=base();draw();
  try{const r=await fetch('/-/palette.json'+(repo?'?repo='+encodeURIComponent(repo)+'&ref='+encodeURIComponent(ref):''),{credentials:'same-origin'});
    if(r.ok){const j=await r.json();(j.repos||[]).forEach(x=>items.push({t:x,u:'/'+x,k:'Repository'}));(j.files||[]).forEach(f=>items.push({t:f,u:'/'+repo+'/blob/'+enc(j.ref||ref||'HEAD')+'/'+enc(f),k:'File'}));draw()}}catch(_){}}
function score(q,s){if(!q)return 1;let i=0,sc=0,last=-2;const lo=s.toLowerCase();const at=lo.indexOf(q);if(at>=0)return 1000-at-(s.length/100);
  for(const ch of q){const k=lo.indexOf(ch,i);if(k<0)return -1;sc+=k===last+1?5:1;if(k===0||'/ -_.'.includes(lo[k-1]))sc+=3;last=k;i=k+1}return sc-(s.length/100)}
function draw(){if(!ul)return;const q=inp.value.trim().toLowerCase();let list=(items||[]).map(x=>[score(q,x.t),x]).filter(a=>a[0]>=0).sort((a,b)=>b[0]-a[0]).slice(0,60).map(a=>a[1]);
  const m=/^#?(\\d+)$/.exec(q);if(m&&repo)list.unshift({t:'Go to #'+m[1],u:'/'+repo+'/issues/'+m[1],k:'Issue / PR'});
  shown=list;if(sel>=shown.length)sel=Math.max(0,shown.length-1);
  ul.replaceChildren(...shown.map((x,i)=>{const li=d.createElement('li');if(i===sel)li.className='sel';const a=d.createElement('a');a.href=x.u;a.textContent=x.t;const k=d.createElement('span');k.textContent=x.k;a.append(k);li.append(a);return li}));
  const s=$('li.sel',ul);s&&s.scrollIntoView({block:'nearest'})}
function openPalette(){if(!dlg)return;if(!dlg.open)dlg.showModal();inp.value='';sel=0;load();draw();inp.focus()}
if(dlg){inp.addEventListener('input',()=>{sel=0;draw()});
  inp.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,shown.length-1);draw()}else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);draw()}else if(e.key==='Enter'){e.preventDefault();const x=shown[sel];if(x)location.href=x.u}});
  dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close()})}
// Shortcuts
let g=0;
d.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();return}
  const t=e.target;if(t&&t.closest&&t.closest('input,textarea,select,[contenteditable],dialog,.dfy-k,[role=listbox]'))return;
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  if(g&&Date.now()-g<1500){g=0;const m={c:'',i:'/issues',p:'/pulls',a:'/actions',s:'/settings'}[e.key];if(repo&&m!==undefined){e.preventDefault();location.href='/'+repo+m}else if(e.key==='d'){location.href='/'}else if(e.key==='n'){location.href='/notifications'}return}
  if(e.key==='g'){g=Date.now();return}
  if(e.key==='t'&&repo){e.preventDefault();openPalette();return}
  if(e.key==='/'){const s=$('input[type=search]');if(s){e.preventDefault();s.focus()}}
});
// Live updates
const live=b.dataset.live,mode=b.dataset.liveMode||'reload';
if(live&&repo&&'WebSocket' in window){let ws,tries=0,timer=null,lastSeq=Number(b.dataset.lastSeq||'-1'),opened=false,planned=false;
  function connect(){ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/'+repo+'/live?topics='+encodeURIComponent(live));
    ws.onopen=()=>{if(opened){if(mode!=='log')refresh();else if(!planned)location.reload()}opened=true;planned=false;tries=0};
    ws.onmessage=e=>{if(e.data==='pong')return;let m;try{m=JSON.parse(e.data)}catch(_){return}handle(m)};
    ws.onclose=e=>{planned=e.code===4001;setTimeout(connect,planned?0:Math.min(30000,1000*Math.pow(2,tries++)))}}
  setInterval(()=>{if(ws&&ws.readyState===1)ws.send('ping')},25000);
  function handle(m){const a=m.data&&m.data.action;
    if(mode==='log'){if(!String(m.topic).startsWith('job:'))return;
      if(a==='logs'){append(m.data.lines||[]);return}
      if(a==='step'&&m.data.step){stepState(m.data.step);return}
      if(a==='completed'||a==='restarted'){setTimeout(()=>location.reload(),700)}return}
    clearTimeout(timer);timer=setTimeout(refresh,350)}
  async function refresh(){const frags=$$('[data-fragment]');if(!frags.length){location.reload();return}
    try{const r=await fetch(location.href,{credentials:'same-origin'});if(!r.ok)return;const doc=new DOMParser().parseFromString(await r.text(),'text/html');
      const kp=d.getElementById('dfy-k-portal');if(kp&&kp.childElementCount){setTimeout(refresh,1500);return}for(const f of frags){if(f.contains(d.activeElement)&&d.activeElement!==b)continue;const n=doc.querySelector('[data-fragment="'+f.dataset.fragment+'"]');if(n)f.replaceWith(d.importNode(n,true))}}catch(_){}}
  function clean(s){return s.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g,'')}
  function section(step){let s=$('.log [data-step="'+step+'"]');if(!s){const log=$('.log');if(!log)return null;s=d.createElement('details');s.open=true;s.dataset.step=step;
      const sm=d.createElement('summary');sm.innerHTML='<span class="st spin run"></span>';sm.append(step<0?'Set up job':'Step '+(step+1));s.append(sm,d.createElement('pre'));log.append(s)}
    return $('pre',s)}
  function append(lines){const follow=(innerHeight+scrollY)>=d.body.scrollHeight-80;
    for(const l of lines){if(l.seq<=lastSeq)continue;lastSeq=l.seq;const pre=section(l.step);if(!pre)continue;const sp=d.createElement('span');const t=clean(l.text);
      if(t.startsWith('::group::')){sp.className='grp';sp.textContent='\\u25be '+t.slice(9)}else if(/^##\\[error\\]|^::error/.test(t)){sp.className='err';sp.textContent=t}else if(/^::warning/.test(t)){sp.className='wrn';sp.textContent=t}else sp.textContent=t;
      pre.append(sp);const det=pre.parentElement;if(det&&!det.open)det.open=true}
    if(follow)scrollTo(0,d.body.scrollHeight)}
  function stepState(s){if(!$('.log [data-step="'+s.index+'"]'))section(s.index);const sec=$('.log [data-step="'+s.index+'"]');if(!sec)return;const sm=$('summary',sec);if(!sm)return;const icon=$('.st',sm);
    if(s.status==='completed'&&icon){icon.className='st '+(s.conclusion==='success'?'ok':s.conclusion==='failure'?'bad':'faint');icon.textContent=s.conclusion==='success'?'\\u2713':s.conclusion==='failure'?'\\u2715':'\\u2212'}
    if(s.name){const label=[...sm.childNodes].find(n=>n.nodeType===3);if(label)label.textContent=s.name}}
  connect()}
})();`;

/** Inline SVG icons (16×16, Phosphor, see scripts/make-ui-icons.mjs) plus the logo. Static strings only. */
export const ICONS = {
  logo: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.3 7.2c4 1 7.4 2.2 7.6 3.3M8.3 16.8c4-1 7.4-2.2 7.6-3.3"/></svg>`,
  ...UI_ICONS,
} as const;

export type IconName = keyof typeof ICONS;
