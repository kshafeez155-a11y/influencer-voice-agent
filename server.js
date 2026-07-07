require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
// const OpenAI = require("openai");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use("/audio", express.static("public/audio"));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });
app.get("/", (req, res) => {
  res.send("Voice agent server is running");
});

app.get("/make-call", async (req, res) => {
  try {
    const call = await client.calls.create({
      to: process.env.MY_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/voice`,
    });

    console.log("Call started:", call.sid);
    res.send("Call started. Check your phone.");
  } catch (error) {
    console.error("Call error:", error.message);
    res.status(500).send("Call failed: " + error.message);
  }
});

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    {
      voice: "alice",
      language: "en-IN",
    },
    "Hello. This is your influencer promotion assistant. Please say something after the beep."
  );

  twiml.record({
    action: "/handle-recording",
    method: "POST",
    maxLength: 10,
    playBeep: true,
    trim: "trim-silence",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});



app.post("/handle-recording", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const recordingDuration = req.body.RecordingDuration;
  const callerNumber = req.body.From;

  console.log("Recording received");
  console.log("Caller:", callerNumber);
  console.log("Recording URL:", recordingUrl);
  console.log("Duration:", recordingDuration);
  try {
  const audioUrl = recordingUrl + ".mp3";

  console.log("Audio URL being downloaded:", audioUrl);

  const audioResponse = await fetch(audioUrl, {
  headers: {
    Authorization:
      "Basic " +
      Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString("base64"),
  },
});

console.log("Twilio download status:", audioResponse.status);
console.log("Twilio download OK:", audioResponse.ok);

const audioBuffer = await audioResponse.arrayBuffer();

const dgResponse = await fetch(
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

  const result = await dgResponse.json();

  if (!dgResponse.ok) {
    console.log("Deepgram error:", result);
  } else {
    const transcript =
      result.results.channels[0].alternatives[0].transcript;

    console.log("User said:", transcript);

    const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "llama3.2",
    messages: [
      {
        role: "system",
        content: `
You are an influencer promotion phone assistant.
Ask only one question at a time.
Keep replies short.
Speak like a polite phone assistant.

Your job is to collect:
caller name, brand name, product/service, promotion type, budget, deadline, location, preferred influencer.
`,
      },
      {
        role: "user",
        content: transcript,
      },
    ],
    stream: false,
  }),
});

const ollamaData = await ollamaResponse.json();
const aiText = ollamaData.message.content;

console.log("AI replied:", aiText);
const elevenResponse = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
  {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: aiText,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  }
);

if (!elevenResponse.ok) {
  const errorText = await elevenResponse.text();
  console.log("ElevenLabs Error:", errorText);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Sorry, I could not create the voice reply.");
  twiml.hangup();

  res.type("text/xml");
  return res.send(twiml.toString());
}

const audioArrayBuffer = await elevenResponse.arrayBuffer();

const fileName = `reply-${Date.now()}.mp3`;
const audioDir = path.join(__dirname, "public", "audio");
const filePath = path.join(audioDir, fileName);

if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

fs.writeFileSync(filePath, Buffer.from(audioArrayBuffer));

const replyAudioUrl = `${process.env.BASE_URL}/audio/${fileName}`;

console.log("Reply audio URL:", replyAudioUrl);
  }
} catch (error) {
  console.log("Transcription failed:", error.message);
}
  const twiml = new twilio.twiml.VoiceResponse();

 if (typeof replyAudioUrl !== "undefined") {
  twiml.play(replyAudioUrl);
} else {
  twiml.say(
    {
      voice: "alice",
      language: "en-IN",
    },
    "Sorry, I could not create the voice reply."
  );
}

  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});