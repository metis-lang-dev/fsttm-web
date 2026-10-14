"""The page ↔ backend wire, in Python terms (metis-agent docs/FRAMEWORK.md
§5; the page side is web/backend/ws.js). JSON text frames on one
websocket, each an object with `ev`.

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
    task / say / runtime_intent / rack_mount   the metis-agent harness's extras

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

An application's page may extend the wire (metis-agent's console adds
hello/journal/catalog/ports/world); the dialog needs only the above.
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
