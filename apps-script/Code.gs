/**
 * @OnlyCurrentDoc
 *
 * Paste this into the Google Sheet: Extensions → Apps Script → replace Code.gs → Save.
 * It does three things:
 *   1. Serves the sheet as JSON (doGet) for the website build.
 *   2. Adds a "Website" menu: Publish now / Turn on automatic publishing / Set up tabs.
 *   3. Auto-publishes: every 15 min it checks for changes and triggers a rebuild once edits
 *      have settled, plus a refresh every 6 h so new YouTube videos appear on their own.
 *
 * GitHub token: Website → Connect GitHub… stores it in Script Properties (never in this file).
 * Fine-grained token, this repo only, permission "Actions: Read and write".
 */

var GITHUB_REPO = 'UberMayinch/mohita-site'; // owner/repo
var GITHUB_BRANCH = 'main';
var WORKFLOW_FILE = 'deploy.yml';
var REFRESH_HOURS = 6;

// ------------------------------------------------------------------ JSON for the build

function doGet() {
  var body = { version: 1, generatedAt: new Date().toISOString(), tabs: snapshot_() };
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/** Every tab except ones starting with "_", exactly as displayed (dates, "Present", etc. stay as typed). */
function snapshot_() {
  var tabs = {};
  SpreadsheetApp.getActive().getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name.charAt(0) === '_') return;
    tabs[name] = sheet.getDataRange().getDisplayValues();
  });
  return tabs;
}

// ------------------------------------------------------------------ menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Website')
    .addItem('Publish now', 'publishNow')
    .addSeparator()
    .addItem('Turn on automatic publishing', 'enableAutoPublish')
    .addItem('Set up tabs (first time only)', 'setupTabs')
    .addItem('Connect GitHub…', 'connectGitHub')
    .addToUi();
}

function publishNow() {
  try {
    dispatch_('published from sheet menu');
    SpreadsheetApp.getActive().toast('The website will update in about 2 minutes.', 'Publishing…', 8);
  } catch (err) {
    SpreadsheetApp.getUi().alert('Could not publish', String(err.message || err), SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

function connectGitHub() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Connect GitHub', 'Paste the fine-grained token for ' + GITHUB_REPO + ' (Actions: Read and write):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var token = res.getResponseText().trim();
  if (!token) return;
  PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', token);
  try {
    dispatch_('connected from sheet');
    ui.alert('Connected', 'Token works — a publish was started.', ui.ButtonSet.OK);
  } catch (err) {
    PropertiesService.getScriptProperties().deleteProperty('GITHUB_TOKEN');
    ui.alert('Token did not work', String(err.message || err), ui.ButtonSet.OK);
  }
}

function enableAutoPublish() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoPublish') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoPublish').timeBased().everyMinutes(15).create();
  SpreadsheetApp.getUi().alert(
    'Automatic publishing is on',
    'Changes go live about 15–30 minutes after you stop editing. Use Website → Publish now for an instant update.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ------------------------------------------------------------------ auto publish

/** Runs every 15 min. Publishes when the sheet changed and has been stable for one check. */
function autoPublish() {
  var props = PropertiesService.getScriptProperties();
  var hash = hash_(snapshot_());
  var seen = props.getProperty('SEEN_HASH');
  var published = props.getProperty('PUBLISHED_HASH');
  var last = Number(props.getProperty('LAST_PUBLISHED') || 0);
  props.setProperty('SEEN_HASH', hash);

  var settledChange = hash !== published && hash === seen;
  var due = Date.now() - last > REFRESH_HOURS * 3600 * 1000;
  if (settledChange || due) dispatch_(settledChange ? 'sheet changed' : 'scheduled refresh');
}

function dispatch_(reason) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('GITHUB_TOKEN');
  var repo = GITHUB_REPO;
  if (!token) throw new Error('Not connected to GitHub yet — use Website → Connect GitHub…');
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/actions/workflows/' + WORKFLOW_FILE + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ ref: GITHUB_BRANCH, inputs: { reason: reason } }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 204) {
    throw new Error('GitHub replied ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  props.setProperties({ PUBLISHED_HASH: hash_(snapshot_()), LAST_PUBLISHED: String(Date.now()) });
}

function hash_(obj) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(obj)));
}

// ------------------------------------------------------------------ first-time setup

var TABS = [
  {
    name: 'Profile',
    rows: [
      ['Field', 'Value', 'What it is'],
      ['name', '', 'Your full name (required)'],
      ['headline', '', 'One line under your name, e.g. "Leadership coach & speaker"'],
      ['intro', '', '1–2 sentences at the top of the page'],
      ['about', '', 'Longer bio. New line inside a cell: Ctrl+Enter (Mac: Cmd+Enter). Blank line = new paragraph'],
      ['photo', '', 'Link to your photo in Google Drive (Share → Anyone with the link)'],
      ['location', '', 'City, Country'],
      ['email', '', 'Contact email shown on the site'],
      ['cta_label', '', 'Optional: main button text, e.g. "Book a call"'],
      ['cta_link', '', 'Optional: main button link, e.g. a Calendly page'],
      ['resume_pdf', '', 'Optional: link to resume PDF in Drive (Anyone with the link)'],
      ['linkedin_url', '', 'Profile link'],
      ['youtube_url', '', 'Channel link — new videos appear on the site automatically'],
      ['instagram_url', '', 'Profile link'],
      ['x_url', '', 'Optional'],
      ['facebook_url', '', 'Optional'],
      ['contact_heading', "Let's work together", 'Heading of the contact box'],
      ['contact_text', '', 'Short line under it'],
      ['accent_color', '#1E5B57', 'Main colour (hex code)'],
      ['site_url', 'https://mohita.live', 'Website address (leave as is)'],
      ['meta_description', '', 'Optional: text Google shows under your name'],
    ],
    widths: [150, 420, 460],
  },
  { name: 'Highlights', rows: [['Value', 'Label']], widths: [120, 300] },
  { name: 'Services', rows: [['Title', 'Description']], widths: [220, 520] },
  {
    name: 'Content',
    rows: [['Link', 'Title', 'Date', 'Note', 'Featured', 'Hide', 'Image', 'Platform']],
    widths: [360, 300, 110, 360, 80, 60, 200, 100],
    dateCol: 3,
    yesCols: [5, 6],
  },
  {
    name: 'Resume',
    rows: [['Section', 'Title', 'Organization', 'Dates', 'Details']],
    widths: [120, 240, 220, 140, 420],
  },
  {
    name: '_Read me',
    rows: [
      ['How this sheet runs your website'],
      ['• Edit any tab. The site updates by itself within ~30 minutes, or use the Website menu → Publish now.'],
      ['• Content: paste a link in column A — that is all that is required. Title, date and note are optional.'],
      ['• YouTube videos appear automatically; add one here only to feature it or write your own note.'],
      ['• Set "Featured" to yes to pin a post to the top. Set "Hide" to yes to remove something without deleting it.'],
      ['• Do not rename tabs or the header row (row 1). Tabs starting with _ are ignored by the website.'],
    ],
    widths: [800],
  },
];

function setupTabs() {
  var ss = SpreadsheetApp.getActive();
  TABS.forEach(function (def) {
    var sheet = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    if (sheet.getLastRow() > 0) return; // never overwrite existing data
    var width = def.rows[0].length;
    sheet.getRange(1, 1, def.rows.length, width).setValues(def.rows);
    sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#f3efe8');
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 500, width).setWrap(true).setVerticalAlignment('top');
    def.widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
    if (def.dateCol) sheet.getRange(2, def.dateCol, 499, 1).setNumberFormat('yyyy-mm-dd');
    // A "yes"/blank dropdown, not checkboxes: checkboxes store FALSE in every row, which makes
    // API appends (e.g. an automation adding posts) land below row 500.
    var yes = SpreadsheetApp.newDataValidation().requireValueInList(['yes'], true).setAllowInvalid(true).build();
    (def.yesCols || []).forEach(function (c) { sheet.getRange(2, c, 499, 1).setDataValidation(yes); });
  });
  var first = ss.getSheets()[0];
  if (/^(Sheet1|Sheet 1)$/.test(first.getName()) && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  ss.setActiveSheet(ss.getSheetByName('Profile'));
  SpreadsheetApp.getUi().alert('Tabs are ready. Fill in the Profile tab first.');
}
