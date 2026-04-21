const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Replace with your Prolific completion URL once you have it.
const PROLIFIC_COMPLETION_URL = 'https://app.prolific.com/submissions/complete?cc=C1K5H2UT';


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

  const { error } = await supabase.from('results').insert(row);

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ success: false, error: 'Failed to save data' });
  }

  res.json({ success: true, completion_url: PROLIFIC_COMPLETION_URL });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Matching task running → http://localhost:${PORT}`));
