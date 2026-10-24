"""The page ↔ backend wire, the library's own protocol, in Python terms (the
page side is web/backend/ws.js; the README's "The wire"). JSON text frames on
one websocket, each an object with `ev`.

A backend answers the dialog's turns; everything else is optional and the
reference page logs what it does not know.

Page → backend
    say_text  {id, text, mode}     an utterance; mode "intent" (one short
                                   spoken ack, the intent JSON) or "talk"
                                   (free dialog, sentences streamed); the
                                   page sets id ("<session>-t3")
    cut       {id, heard}          barge-in: turn id was heard up to `heard`
                                   (the backend's history keeps only that)
    heard     {id, text}           a narration id was voiced, this much of it

Backend → page
    intent     {id, intent, voice}   the answer to an intent turn: intent is
                                     the JSON (an object, or its text), voice
                                     the line the page speaks
    talk       {id, text, done}      a talk turn, one sentence per frame;
                                     done on the last (text may be "")
    error      {id, error}           the turn failed
    narration  {id, path, kind, form, line, sentence}
                                     something the backend wants said; the
                                     page voices it when the floor is free
                                     (form R: shown, never voiced)

Host ↔ page: the panel's backchannel (lib/panel.js; fsttm_web.chat is the host's side). The
host is whoever holds the backend's socket; the page sends back only when it opts in (Panel's
`host`, the reference page's ?host).

Host → page
    chat   {who: "user", text, id?}     a line as the person's: the panel's one entry (the
                                        floor, attention, a turn on the backend)
    chat   {who: "system", text, id?, voice?}
                                        her words: shown, and spoken unless voice is false
                                        (a narration, kind announce, behind it)
    ctl    {barge_in?, voice?, attention?, reply?, mic?}
                                        the strip's controls: barge_in words|energy|none,
                                        attention awake|asleep, reply one of the page's
                                        modes ("mode" is its other name), mic on|off
Page → host
    chat   {who, text, row, id, via, tags, kind?}
                                        every row the panel shows, and again on each new
                                        tag: who user|system|intent|note, via typed|heard|
                                        host|say|backend|panel, tags spoken, cut · heard …
    event  {kind, t, …}                 every dialog event (the panel's events section)
    state  {floor, attention, channel, mode, reply, barge_in, recognizer, voice, listening}
                                        on every change

An application extends the wire with frames of its own, either way: any other
`ev` is the application's. The library neither defines nor needs them; the
reference page logs those it does not know (WsBackend's onFrame), and a page
sends its own with WsBackend.send(frame). parse() accepts any frame with an
`ev`, so a backend sees them too. The dialog needs only the above.
"""
import json
import re
from typing import Literal, TypedDict


class SayText(TypedDict):
    ev: Literal["say_text"]
    id: str
    text: str
    mode: Literal["intent", "talk"]


class Cut(TypedDict):
    ev: Literal["cut"]
    id: str
    heard: str


class Intent(TypedDict):
    ev: Literal["intent"]
    id: str
    intent: object
    voice: str


class Talk(TypedDict):
    ev: Literal["talk"]
    id: str
    text: str
    done: bool


class Narration(TypedDict, total=False):
    ev: Literal["narration"]
    id: str
    path: str
    kind: str
    form: Literal["R", "N", "R+N"]
    line: str
    sentence: str


def intent(id, intent, voice):
    return {"ev": "intent", "id": id, "intent": intent, "voice": voice}


def talk(id, text, done=False):
    return {"ev": "talk", "id": id, "text": text, "done": done}


def error(id, err):
    return {"ev": "error", "id": id, "error": str(err)}


def narration(id, sentence, kind="announce", form="N", path="", line=""):
    return {"ev": "narration", "id": id, "path": path, "kind": kind, "form": form, "line": line, "sentence": sentence}


def chat(who, text, id=None, voice=None):
    """A chat line to the page: who "user" (as the person) or "system" (as her)."""
    f = {"ev": "chat", "who": who, "text": text}
    if id is not None:
        f["id"] = id
    if voice is not None:
        f["voice"] = bool(voice)
    return f


def ctl(**controls):
    """The strip's controls to the page: barge_in, voice, attention, reply (or mode), mic."""
    return {"ev": "ctl", **{k: v for k, v in controls.items() if v is not None}}


HOST_FRAMES = ("chat", "event", "state")
"""The frames a page sends its host (the backchannel), as a backend tells them from its own."""


def sentences(text):
    """The page's speaking units (tts.js splitSentences, without its
    40-character merge): a talk turn streams one per frame."""
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def parse(raw):
    """A frame from the page, or None when it is not one."""
    try:
        m = json.loads(raw)
    except ValueError:
        return None
    return m if isinstance(m, dict) and isinstance(m.get("ev"), str) else None


class Echo:
    """A stub backend: an intent turn answers CHITCHAT and speaks back what
    it heard; a talk turn streams two sentences. What the page sends is kept
    (frames), so a test can read the cuts and the heard texts."""

    def __init__(self):
        self.frames = []

    def handle(self, m):
        """One page frame → the frames to send back (a list)."""
        self.frames.append(m)
        if m.get("ev") != "say_text":
            return []
        i, t = m.get("id", ""), str(m.get("text", "")).strip()
        if m.get("mode") == "talk":
            return [talk(i, s) for s in sentences(f"You said: {t}. That is all I can say, I am a stub.")] + [talk(i, "", True)]
        return [intent(i, {"intent": "CHITCHAT"}, f"You said: {t}.")]
