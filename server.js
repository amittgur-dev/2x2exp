const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Replace with your Prolific completion URL once you have it.
const PROLIFIC_COMPLETION_URL = 'https://app.prolific.com/submissions/complete?cc=C1K5H2UT';
// Prolific completion URL for the 4x4 study (duplicated study, same code as the 2x2 study).
const PROLIFIC_COMPLETION_URL_4X4 = 'https://app.prolific.com/submissions/complete?cc=C1K5H2UT';


// ── Destination tables ───────────────────────────────────────────────────────
// Change these to start a clean collection; the old table keeps its history.
// A new table must have RLS disabled or every insert is rejected (see notes).
const TABLE_2X2    = 'results';
const TABLE_4X4    = 'results_4x4_v3';
const TABLE_RATING = 'ratings_v3';

// Closing questionnaire: accept only a boolean and a whole number of years,
// otherwise store null rather than rejecting (and losing) the whole session.
function cleanMusic(training, years, formal) {
  const t = typeof training === 'boolean' ? training : null;
  const y = t === true && Number.isInteger(years) && years >= 1 && years <= 80 ? years : null;
  const f = y !== null && Number.isInteger(formal) && formal >= 0 && formal <= y ? formal : null;
  return { musical_training: t, musical_training_years: y, musical_training_formal_years: f };
}

// Play counts and durations: a whole number in range, otherwise null.
function nonNegInt(v, max) {
  return Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}
const MAX_PLAYS = 10000;
const MAX_MS    = 24 * 60 * 60 * 1000;
const STIM_KEYS = ['rfrm', 'rfsm', 'sfsm', 'sfrm'];

// ── Authenticity checks (4x4 and rating studies) ────────────────────────────
// Nothing here blocks a participant; every result is stored as a flag to review.
//  · ai_check: the closing question has one right answer ("correct") and one
//    option that is named only in a line of the page that people cannot see but
//    page-reading software can ("trap"). Any other choice is "other".
//  · hidden_field_filled: a text box people cannot see or reach; true means
//    software typed into it.
//  · audio_check_*: three spoken digits, typed in. The answers are kept here,
//    not in the page.
//  · auto_webdriver / untrusted_events / pointer_* / drag_*: passive signals —
//    the browser says it is automated; clicks or keys produced by script; how
//    much the pointer moved; and (4x4) how many samples a drag had and how
//    straight it was (1 = a perfect line, which a hand does not draw).
// The page sends neutral field names; the evaluation happens here.
const CHECK_CORRECT = 'sounds_images';
const CHECK_TRAP    = 'stories';
const SOUNDCHECK_ANSWERS = { '1': '274', '2': '618', '3': '386', '4': '741' };

const CHECK_COLUMNS = [
  'ai_check', 'hidden_field_filled',
  'audio_check_clip', 'audio_check_answer', 'audio_check_correct', 'audio_check_plays',
  'auto_webdriver', 'untrusted_events', 'pointer_moves', 'pointer_clicks'
];
const DRAG_COLUMNS = ['drag_count', 'drag_moves_median', 'drag_straightness_median'];

function boundedNumber(v, max, decimals) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function cleanChecks(b) {
  const choice = typeof b.final_check === 'string' ? b.final_check : null;
  const clip   = typeof b.soundcheck_clip === 'string'
                 && Object.prototype.hasOwnProperty.call(SOUNDCHECK_ANSWERS, b.soundcheck_clip) ? b.soundcheck_clip : null;
  const typed  = typeof b.soundcheck_answer === 'string' ? b.soundcheck_answer.replace(/\D/g, '').slice(0, 10) : null;
  return {
    ai_check: choice === null ? null
            : choice === CHECK_CORRECT ? 'correct' : choice === CHECK_TRAP ? 'trap' : 'other',
    hidden_field_filled: typeof b.extra_comments === 'string' ? b.extra_comments.trim() !== '' : null,
    audio_check_clip:    clip,
    audio_check_answer:  typed,
    audio_check_correct: clip !== null && typed !== null ? typed === SOUNDCHECK_ANSWERS[clip] : null,
    audio_check_plays:   nonNegInt(b.soundcheck_plays, MAX_PLAYS),
    auto_webdriver:      typeof b.auto_webdriver === 'boolean' ? b.auto_webdriver : null,
    untrusted_events:    nonNegInt(b.untrusted_events, 1e7),
    pointer_moves:       nonNegInt(b.pointer_moves, 1e8),
    pointer_clicks:      nonNegInt(b.pointer_clicks, 1e7)
  };
}
function cleanDrags(b) {
  return {
    drag_count:               nonNegInt(b.drag_count, 1e5),
    drag_moves_median:        boundedNumber(b.drag_moves_median, 1e6, 1),
    drag_straightness_median: boundedNumber(b.drag_straightness_median, 1, 3)
  };
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Insert; if the table lacks one of the newest columns (added in Supabase after
// the code), save the session without those columns instead of losing it.
// savedWithout lists any columns dropped that way; the endpoints echo it in
// their reply (participants never see it), so a test save shows at once
// whether the table is complete.
const MISSING_COLUMN = ['PGRST204', '42703'];
async function insertRows(table, rows, newColumns) {
  let { error } = await supabase.from(table).insert(rows);
  if (!error || !MISSING_COLUMN.includes(error.code)) return { error, savedWithout: [] };
  console.error(`WARNING: ${table} is missing a column (${error.message}). `
    + `Saving without: ${newColumns.join(', ')} — add them in Supabase.`);
  const strip = r => { const c = { ...r }; newColumns.forEach(k => delete c[k]); return c; };
  ({ error } = await supabase.from(table).insert(Array.isArray(rows) ? rows.map(strip) : strip(rows)));
  return { error, savedWithout: error ? [] : newColumns };
}
const savedNote = cols => cols.length ? { saved_without: cols } : {};

function checkCongruency(leftImage, leftSound, rightImage, rightSound) {
  // Congruent if either side has a matching same-name pair (e.g. RFRM + RFRM_sound, or SFSM + SFSM_sound).
  const sameName = (img, snd) => img && snd && snd === img + '_sound';
  return (sameName(leftImage, leftSound) || sameName(rightImage, rightSound))
    ? 'congruent' : 'incongruent';
}

app.post('/submit', async (req, res) => {
  const { prolific_pid, study_id, session_id, left_image, left_sound, right_image, right_sound, response_time_ms } = req.body;

  if (!left_image || !left_sound || !right_image || !right_sound) {
    return res.status(400).json({ success: false, error: 'Incomplete data' });
  }

  const row = {
    prolific_pid:     prolific_pid  || 'unknown',
    study_id:         study_id      || 'unknown',
    session_id:       session_id    || 'unknown',
    timestamp:        new Date().toISOString(),
    left_image,
    left_sound,
    right_image,
    right_sound,
    congruency:       checkCongruency(left_image, left_sound, right_image, right_sound),
    response_time_ms
  };

  const { error } = await supabase.from(TABLE_2X2).insert(row);

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ success: false, error: 'Failed to save data' });
  }

  res.json({ success: true, completion_url: PROLIFIC_COMPLETION_URL });
});

const COLUMNS_4X4_PLAYS = [...STIM_KEYS.map(s => 'plays_' + s), ...STIM_KEYS.map(s => 'confirm_plays_' + s)];

app.post('/submit-4x4', async (req, res) => {
  const {
    prolific_pid, study_id, session_id,
    g1_image, g1_sound, g2_image, g2_sound,
    g3_image, g3_sound, g4_image, g4_sound,
    response_time_ms, px_per_mm,
    musical_training, musical_training_years, musical_training_formal_years
  } = req.body;

  const groups = [
    [g1_image, g1_sound], [g2_image, g2_sound],
    [g3_image, g3_sound], [g4_image, g4_sound]
  ];
  if (groups.some(([i, s]) => !i || !s)) {
    return res.status(400).json({ success: false, error: 'Incomplete data' });
  }

  const isMatch = (img, snd) => snd === img + '_sound';
  const matched_pairs = groups.reduce((n, [i, s]) => n + (isMatch(i, s) ? 1 : 0), 0);

  const row = {
    prolific_pid: prolific_pid || 'unknown',
    study_id:     study_id     || 'unknown',
    session_id:   session_id   || 'unknown',
    timestamp:    new Date().toISOString(),
    g1_image, g1_sound, g2_image, g2_sound,
    g3_image, g3_sound, g4_image, g4_sound,
    matched_pairs,
    response_time_ms,
    px_per_mm,
    ...cleanMusic(musical_training, musical_training_years, musical_training_formal_years)
  };
  // completed plays of each sound, on the matching screen and on the confirmation
  // screen, plus the time spent on the matching screen (response_time_ms covers both)
  COLUMNS_4X4_PLAYS.forEach(k => { row[k] = nonNegInt(req.body[k], MAX_PLAYS); });
  row.matching_time_ms = nonNegInt(req.body.matching_time_ms, MAX_MS);
  Object.assign(row, cleanChecks(req.body), cleanDrags(req.body));

  const { error, savedWithout } = await insertRows(TABLE_4X4, row, [...CHECK_COLUMNS, ...DRAG_COLUMNS]);

  if (error) {
    console.error('Supabase error (4x4):', error);
    return res.status(500).json({ success: false, error: 'Failed to save data' });
  }

  res.json({ success: true, completion_url: PROLIFIC_COMPLETION_URL_4X4, ...savedNote(savedWithout) });
});

// ── Rating study (/rating/) ──────────────────────────────────────────────────
// Completion code comes from the environment, never from source (public repo).
// A missing/malformed code must be LOUD at boot: without it participants finish
// the task and have no way back to Prolific. We warn rather than exit, because
// this same process also serves the 2x2 and 4x4 studies.
const RATING_CC = process.env.PROLIFIC_CC_RATING;
let ratingCompletionCode = null;

if (!RATING_CC) {
  console.error('WARNING: PROLIFIC_CC_RATING is not set — /rating/ participants will NOT be redirected to Prolific.');
} else if (!/^[A-Za-z0-9]{4,20}$/.test(RATING_CC)) {
  console.error(`WARNING: PROLIFIC_CC_RATING looks wrong (${RATING_CC}). Set the bare completion code, not a full URL.`);
} else {
  ratingCompletionCode = RATING_CC;
  console.log('Rating study completion code loaded.');
}

const PROLIFIC_COMPLETION_URL_RATING = ratingCompletionCode
  ? `https://app.prolific.com/submissions/complete?cc=${ratingCompletionCode}`
  : null;

// Explicit whitelist: never spread raw client JSON into an insert — one unexpected
// key makes Supabase reject the whole batch and the session is lost.
const RATING_COLUMNS = [
  'prolific_pid', 'study_id', 'session_id',
  'trial_index', 'direction', 'block_order', 'block_position',
  'reference', 'comparison', 'position',
  'rating', 'slider_start', 'ref_plays', 'comp_plays',
  'trial_rt_ms', 'px_per_mm'
];
// Familiarization step (before round 1): completed plays of each sound, and its
// duration. Participant-level, so repeated on each of the participant's 32 rows.
const RATING_FAM_COLUMNS = [...STIM_KEYS.map(s => 'fam_plays_' + s), 'fam_time_ms'];

app.post('/submit-ratings', async (req, res) => {
  const { ratings } = req.body;

  if (!Array.isArray(ratings) || ratings.length !== 32) {
    const n = Array.isArray(ratings) ? ratings.length : 'none';
    return res.status(400).json({ success: false, error: `Expected 32 rating rows, got ${n}` });
  }

  const timestamp = new Date().toISOString();
  const rows = ratings.map(r => {
    const row = { timestamp };
    RATING_COLUMNS.forEach(k => { row[k] = r[k] === undefined ? null : r[k]; });
    Object.assign(row, cleanMusic(r.musical_training, r.musical_training_years, r.musical_training_formal_years));
    RATING_FAM_COLUMNS.forEach(k => { row[k] = nonNegInt(r[k], k === 'fam_time_ms' ? MAX_MS : MAX_PLAYS); });
    Object.assign(row, cleanChecks(r));       // participant-level, repeated on each row
    return row;
  });

  const { error, savedWithout } = await insertRows(TABLE_RATING, rows, CHECK_COLUMNS);

  if (error) {
    console.error('Supabase error (ratings):', error);
    // Surface the database detail: the participant still sees a generic message
    // (the frontend only logs this), but it makes a broken deploy diagnosable.
    return res.status(500).json({
      success: false, error: 'Failed to save data',
      detail: error.message, code: error.code, hint: error.hint
    });
  }

  res.json({
    success: true,
    completion_url: PROLIFIC_COMPLETION_URL_RATING,
    completion_code: ratingCompletionCode,
    ...savedNote(savedWithout)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Matching task running → http://localhost:${PORT}`);
  console.log(`Tables → 2x2: ${TABLE_2X2} | 4x4: ${TABLE_4X4} | rating: ${TABLE_RATING}`);
});
