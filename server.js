require("dotenv").config();

const http = require("http");
const https = require("https");
const express = require("express");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

const app = express();
const DEBUG = process.env.DEBUG !== "false";
const BASE_URL = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : null;

const audioDir = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const keepAliveAgent = {
  http: new http.Agent({ keepAlive: true, maxSockets: 10 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 10 }),
};

const keepAliveFetch = (url, options = {}) =>
  fetch(url, {
    agent: (parsedURL) =>
      parsedURL.protocol === "http:" ? keepAliveAgent.http : keepAliveAgent.https,
    ...options,
  });

const log = (...args) => console.log(...args);
const debug = (...args) => DEBUG && console.log(...args);
const error = (...args) => console.error(...args);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- In-memory conversation store (Map keyed by CallSid) ------------------
// Stores arrays of messages: { role: 'system'|'user'|'assistant', content: '...' }
const conversations = new Map();

// Pending audio files while ElevenLabs generates them: Map<CallSid, filename>
const pendingAudio = new Map();

// (Removed one-time hold announcement per user request)

function getConversation(callSid) {
  if (!conversations.has(callSid)) return null;
  return conversations.get(callSid);
}

function initConversation(callSid) {
  const systemPrompt = `You are a brief influencer promotion phone assistant. Ask one question at a time. Answer in one short sentence. Collect caller name, brand, product/service, promotion type, budget, deadline, location, preferred influencer.`;
  const convo = [{ role: "system", content: systemPrompt }];
  conversations.set(callSid, convo);
  return convo;
}

function appendMessage(callSid, role, content) {
  if (!conversations.has(callSid)) initConversation(callSid);
  const convo = conversations.get(callSid);
  convo.push({ role, content });
  return convo;
}

function clearConversation(callSid) {
  conversations.delete(callSid);
}

// Synchronous fast-path: try to process recording within webhook timeout.
// Returns { type: 'play', publicUrl } or { type: 'say', text } on success.
async function synchronousProcessRecording(callSidLocal, recordingUrlLocal) {
  const audioUrl = recordingUrlLocal + '.mp3';
  log('(sync) Downloading recording for STT:', audioUrl);

  const audioResponse = await keepAliveFetch(audioUrl, {
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
    },
  });

  if (!audioResponse.ok) throw new Error(`Failed to download recording: ${audioResponse.status}`);

  const audioBuffer = await audioResponse.arrayBuffer();

  const dgResponse = await keepAliveFetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/mpeg',
      },
      body: Buffer.from(audioBuffer),
    }
  );

  const dgResult = await dgResponse.json();
  if (!dgResponse.ok) throw new Error(`Deepgram error: ${JSON.stringify(dgResult)}`);

  const transcript = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  log('(sync) Transcript:', transcript);
  if (!transcript) throw new Error('Empty transcript from Deepgram.');

  appendMessage(callSidLocal, 'user', transcript);

  if (userSaidGoodbye(transcript)) {
    const finalText = 'Goodbye! Thank you for your time.';
    appendMessage(callSidLocal, 'assistant', finalText);
    return { type: 'say', text: finalText };
  }

  const conversation = getConversation(callSidLocal) || initConversation(callSidLocal);
  const ollamaResponse = await keepAliveFetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.2', messages: conversation, max_tokens: 32, temperature: 0.3, stream: false }),
  });

  if (!ollamaResponse.ok) {
    const errTxt = await ollamaResponse.text();
    throw new Error(`Ollama error: ${ollamaResponse.status} - ${errTxt}`);
  }

  const ollamaData = await ollamaResponse.json();
  const aiReply = ollamaData?.message?.content?.trim();
  log('(sync) AI replied:', aiReply);

  appendMessage(callSidLocal, 'assistant', aiReply || '');

  if (aiSignalsComplete(aiReply)) {
    return { type: 'say', text: aiReply };
  }

  // Try to generate ElevenLabs audio synchronously
  try {
    const { publicUrl } = await generateElevenLabAudio(callSidLocal, aiReply);
    return { type: 'play', publicUrl };
  } catch (err) {
    error('(sync) ElevenLabs failed, falling back to SAY', err.message);
    return { type: 'say', text: aiReply };
  }
}

// Helper: generate ElevenLabs TTS audio asynchronously and save to public/audio
async function generateElevenLabAudio(callSid, text) {
  try {
    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
      throw new Error('ElevenLabs credentials not configured');
    }

    const fileName = `reply-${callSid}-${Date.now()}.mp3`;
    const audioDir = path.join(__dirname, 'public', 'audio');

    const resp = await keepAliveFetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`ElevenLabs error ${resp.status}: ${txt}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const filePath = path.join(audioDir, fileName);
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    const publicUrl = BASE_URL ? `${BASE_URL}/audio/${fileName}` : `/audio/${fileName}`;
    pendingAudio.set(callSid, { fileName, publicUrl });
    log(`ElevenLabs audio saved for CallSid=${callSid}: ${filePath}`);
    return { fileName, publicUrl };
  } catch (err) {
    console.error('generateElevenLabAudio error:', err.message);
    // ensure no pending marker left
    pendingAudio.delete(callSid);
    throw err;
  }
}

// Log requests for generated audio only in DEBUG mode
app.get('/audio/:file', (req, res, next) => {
  const fileName = req.params.file;
  const filePath = path.join(__dirname, 'public', 'audio', fileName);
  log(`Audio file requested: ${fileName} from ${req.ip} - UA: ${req.get('user-agent')}`);
  if (!fs.existsSync(filePath)) {
    error('Audio file not found:', filePath);
    return res.status(404).send('Not found');
  }
  return res.sendFile(filePath);
});

app.use("/audio", express.static("public/audio"));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.get("/", (req, res) => {
  res.send("Voice agent server is running");
});

app.get("/make-call", async (req, res) => {
  try {
    if (!BASE_URL) throw new Error('BASE_URL is required to create Twilio calls. Set it in your environment.');
    const call = await client.calls.create({
      to: process.env.MY_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice`,
      method: "POST",
    });

    log("Call started:", call.sid);
    res.send("Call started. Check your phone.");
  } catch (error) {
    error("Call error:", error.message);
    res.status(500).send("Call failed: " + error.message);
  }
});

// Entry TwiML: greeting + first record
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || req.query.CallSid || "unknown";

  // Initialize conversation memory for this CallSid
  if (!getConversation(callSid)) {
    initConversation(callSid);
    log(`Initialized conversation for CallSid=${callSid}`);
  }

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    {
      voice: "alice",
      language: "en-IN",
    },
    "Hello. This is your influencer promotion assistant. Please say something after the beep."
  );

  // Ask caller and record their answer. When recording completes Twilio will POST to /handle-recording
  twiml.record({
    action: `/handle-recording`,
    method: "POST",
    maxLength: 30,
    playBeep: true,
    trim: "trim-silence",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// Helper: detect user goodbye words
function userSaidGoodbye(text) {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return /\b(bye|goodbye|thank you|thanks|stop|exit)\b/.test(normalized);
}

// Helper: detect AI end signal (simple heuristic)
function aiSignalsComplete(aiText) {
  if (!aiText) return false;
  const normalized = aiText.toLowerCase();
  return /\b(thank you|goodbye|that\'s all|conversation complete|we are done|no further questions)\b/.test(normalized);
}

// Main recording handler that loops conversation
app.post("/handle-recording", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const recordingDuration = req.body.RecordingDuration;
  const callerNumber = req.body.From;
  const callSid = req.body.CallSid || req.query.CallSid || "unknown";

  log("Recording received (enqueue)", { callSid, callerNumber, recordingUrl, recordingDuration });

  // Quick response to Twilio to avoid webhook timeouts: spawn background processing
  try {
    if (!recordingUrl) throw new Error("No recording URL provided by Twilio.");

    // Background processing: STT -> Ollama -> ElevenLabs -> set pendingAudio
    (async function processRecording(callSidLocal, recordingUrlLocal) {
      try {
        const audioUrl = recordingUrlLocal + ".mp3";
        log("(bg) Downloading recording for STT:", audioUrl);

        const audioResponse = await keepAliveFetch(audioUrl, {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
          },
        });

        if (!audioResponse.ok) throw new Error(`Failed to download recording: ${audioResponse.status}`);

        const audioBuffer = await audioResponse.arrayBuffer();

        const dgResponse = await keepAliveFetch(
          "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
          {
            method: "POST",
            headers: {
              Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
              "Content-Type": "audio/mpeg",
            },
            body: Buffer.from(audioBuffer),
          }
        );

        const dgResult = await dgResponse.json();
        if (!dgResponse.ok) throw new Error(`Deepgram error: ${JSON.stringify(dgResult)}`);

        const transcript = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
        log("(bg) Transcript:", transcript);

        if (!transcript) throw new Error("Empty transcript from Deepgram.");

        appendMessage(callSidLocal, 'user', transcript);

        // If user said goodbye, mark pending as a 'say' final message
        if (userSaidGoodbye(transcript)) {
          const finalText = "Goodbye! Thank you for your time.";
          pendingAudio.set(callSidLocal, { type: 'say', text: finalText });
          appendMessage(callSidLocal, 'assistant', finalText);
          log(`(bg) Marked final SAY for CallSid=${callSidLocal}`);
          return;
        }

        // Send full conversation to Ollama and get assistant reply
        const conversation = getConversation(callSidLocal) || initConversation(callSidLocal);
        const ollamaResponse = await keepAliveFetch("http://localhost:11434/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "llama3.2", messages: conversation, max_tokens: 32, temperature: 0.3, stream: false }),
        });

        if (!ollamaResponse.ok) {
          const errTxt = await ollamaResponse.text();
          throw new Error(`Ollama error: ${ollamaResponse.status} - ${errTxt}`);
        }

        const ollamaData = await ollamaResponse.json();
        const aiReply = ollamaData?.message?.content?.trim();
        log("(bg) AI replied:", aiReply);

        appendMessage(callSidLocal, 'assistant', aiReply || '');

        // If AI signals completion, use a SAY final
        if (aiSignalsComplete(aiReply)) {
          pendingAudio.set(callSidLocal, { type: 'say', text: aiReply });
          log(`(bg) AI signals complete for CallSid=${callSidLocal}`);
          return;
        }

        // Otherwise generate ElevenLabs audio and mark pending
        try {
          const { publicUrl } = await generateElevenLabAudio(callSidLocal, aiReply);
          // pendingAudio is set by generateElevenLabAudio; ensure it's present
          log(`(bg) ElevenLabs audio ready for CallSid=${callSidLocal}: ${publicUrl}`);
        } catch (err) {
          // If ElevenLabs fails, fallback to SAY
          pendingAudio.set(callSidLocal, { type: 'say', text: aiReply });
          error('(bg) ElevenLabs failed, falling back to SAY for CallSid=', callSidLocal, err.message);
        }
      } catch (err) {
        error('(bg) processRecording error for', callSidLocal, err.message);
        pendingAudio.set(callSidLocal, { type: 'say', text: "Sorry, I couldn't process that. Let's try again." });
      }
    })(callSid, recordingUrl);

  } catch (err) {
    error('/handle-recording enqueue error:', err.message);
    // If we cannot enqueue, respond with a safe TwiML to continue
    const failTwiML = new twilio.twiml.VoiceResponse();
    failTwiML.say({ voice: 'alice' }, 'Sorry, an error occurred. Please try again later.');
    failTwiML.hangup();
    res.type('text/xml');
    return res.send(failTwiML.toString());
  }

  // Immediate response: redirect Twilio to /play-audio which will poll pendingAudio
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.redirect(
    { method: 'POST' },
    `/play-audio?callSid=${encodeURIComponent(callSid)}&attempt=0`
  );
  res.type('text/xml');
  return res.send(twiml.toString());
});

// /play-audio: Twilio will be redirected here and this handler will poll until
// the ElevenLabs audio file exists, then return TwiML with <Play> plus a <Record>
app.all('/play-audio', (req, res) => {
  const callSid = req.body.callSid || req.body.CallSid || req.query.callSid || req.query.CallSid;
  const attempt = parseInt(req.query.attempt || req.body.attempt || '0', 10) || 0;
  const maxAttempts = 20; // allow more time for TTS generation

  const twiml = new twilio.twiml.VoiceResponse();

  if (!callSid) {
    twiml.say({ voice: 'alice' }, 'Missing call identifier.');
    twiml.hangup();
    return res.status(400).type('text/xml').send(twiml.toString());
  }

  const pending = pendingAudio.get(callSid);
  if (pending) {
    if (pending.type === 'say') {
      twiml.say({ voice: 'alice' }, pending.text);
      if (aiSignalsComplete(pending.text)) {
        twiml.hangup();
        clearConversation(callSid);
        pendingAudio.delete(callSid);
        log(`SAY final response for CallSid=${callSid}`);
      } else {
        twiml.record({ action: '/handle-recording', method: 'POST', maxLength: 30, playBeep: true, trim: 'trim-silence' });
        pendingAudio.delete(callSid);
        log(`SAY reply for CallSid=${callSid}`);
      }
      return res.type('text/xml').send(twiml.toString());
    }

    if (pending.publicUrl) {
      // Ensure Twilio receives an absolute URL. If BASE_URL wasn't set when
      // the file was generated, the stored URL may be a relative path like
      // "/audio/xxx.mp3". Twilio requires an absolute URL it can fetch.
      const playUrl = /^https?:\/\//i.test(pending.publicUrl)
        ? pending.publicUrl
        : `${req.protocol}://${req.get('host')}${pending.publicUrl}`;

      twiml.play(playUrl);
      twiml.record({ action: '/handle-recording', method: 'POST', maxLength: 30, playBeep: true, trim: 'trim-silence' });
      pendingAudio.delete(callSid);
      log(`Playing audio for CallSid=${callSid}: ${playUrl}`);
      return res.type('text/xml').send(twiml.toString());
    }
  }

  if (attempt >= maxAttempts) {
    twiml.say({ voice: 'alice' }, 'Sorry, I could not prepare the reply in time. Let\'s try again later.');
    twiml.hangup();
    clearConversation(callSid);
    pendingAudio.delete(callSid);
    log(`Play-audio attempts exceeded for CallSid=${callSid}`);
    return res.type('text/xml').send(twiml.toString());
  }

  // Not ready yet: pause and redirect back to poll again. Longer pauses
  // give TTS more time to finish, preventing mid-call hangups. No spoken
  // hold message is played (caller will not hear 'please hold').
  twiml.pause({ length: 3 });
  const nextUrl = `/play-audio?callSid=${encodeURIComponent(callSid)}&attempt=${attempt + 1}`;
  twiml.redirect({ method: 'POST' }, nextUrl);
  log(`Audio not ready for CallSid=${callSid}, attempt=${attempt}. Redirecting to ${nextUrl}`);
  return res.type('text/xml').send(twiml.toString());
});

// Optional: Twilio Status Callback endpoint to clear conversation memory when call ends
// Configure your Twilio call or phone number to POST CallStatus updates to `/call-status`.
app.post('/call-status', (req, res) => {
  const callSid = req.body.CallSid || req.query.CallSid;
  const callStatus = req.body.CallStatus || req.query.CallStatus;
  console.log(`Call status update: CallSid=${callSid}, CallStatus=${callStatus}`);
  // common terminal states: completed, no-answer, busy, failed, canceled
  if (callSid && /^(completed|no-answer|busy|failed|canceled)$/i.test(callStatus)) {
    clearConversation(callSid);
    pendingAudio.delete(callSid);
    console.log(`Cleared conversation memory for CallSid=${callSid} due to status=${callStatus}`);
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
