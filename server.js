require("dotenv").config();

const express = require("express");
const twilio = require("twilio");


const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
  }
} catch (error) {
  console.log("Transcription failed:", error.message);
}
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    {
      voice: "alice",
      language: "en-IN",
    },
    "Thank you. I received your voice recording. Goodbye."
  );

  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});