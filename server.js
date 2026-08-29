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
const TABLE_4X4    = 'results_4x4_v2';
const TABLE_RATING = 'ratings_v2';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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

app.post('/submit-4x4', async (req, res) => {
  const {
    prolific_pid, study_id, session_id,
    g1_image, g1_sound, g2_image, g2_sound,
    g3_image, g3_sound, g4_image, g4_sound,
    response_time_ms, px_per_mm
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
    px_per_mm
  };

  const { error } = await supabase.from(TABLE_4X4).insert(row);

  if (error) {
    console.error('Supabase error (4x4):', error);
    return res.status(500).json({ success: false, error: 'Failed to save data' });
  }

  res.json({ success: true, completion_url: PROLIFIC_COMPLETION_URL_4X4 });
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
    return row;
  });

  const { error } = await supabase.from(TABLE_RATING).insert(rows);

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
    completion_code: ratingCompletionCode
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Matching task running → http://localhost:${PORT}`);
  console.log(`Tables → 2x2: ${TABLE_2X2} | 4x4: ${TABLE_4X4} | rating: ${TABLE_RATING}`);
});
