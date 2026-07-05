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

// This route tells Twilio what to say after you answer the call
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    {
      voice: "alice",
      language: "en-IN",
    },
    "Hello, this is your influencer promotion AI assistant."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// This route starts the call to your mobile number
app.get("/make-call", async (req, res) => {
  try {
    const call = await client.calls.create({
      to: process.env.MY_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/voice`,
      method: "POST",
    });

    res.send(`Calling your phone now. Call SID: ${call.sid}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Call failed. Check terminal error.");
  }
});

app.get("/", (req, res) => {
  res.send("Voice agent server is running");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port 3000");
});