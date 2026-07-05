require("dotenv").config();

const express = require("express");
const twilio = require("twilio");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    {
      voice: "alice",
      language: "en-IN",
    },
    "Hello, welcome to influencer promotion assistant. This is your first test call."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send("Voice agent server is running");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port 3000");
});