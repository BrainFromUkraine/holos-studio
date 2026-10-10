# Holos Studio

**Desktop podcast editor with transcript-based editing, professional voice processing, and AI control via MCP.**

> 🚧 **Status: early development.** Nothing is usable yet — see the [roadmap](docs/ROADMAP.md).

*Holos* (Голос) means "voice" in Ukrainian.

## Why

Making a spoken-word podcast sound professional usually means hours in a DAW: removing filler words, taming breaths, fixing long pauses, de-essing, compressing and hitting loudness targets. Holos Studio aims to make that a fast, text-first workflow that runs locally on your machine:

- **Edit audio by editing text.** Transcribe the recording, delete a word or sentence in the transcript, and the audio is cut with smooth crossfades.
- **Find the junk automatically.** Filler words ("um", "uh", "еее"), false starts and repeats are highlighted for review — you decide what goes.
- **Pro voice chain, one click.** Breath attenuation, pause tightening, de-click, de-ess, EQ, compression, and loudness normalisation to podcast standards (-16 LUFS, -1 dBTP).
- **Non-destructive.** Source recordings are never modified; a project is a JSON edit list you can undo at any point.
- **AI as a collaborator, not a black box.** Holos exposes an [MCP](https://modelcontextprotocol.io) server, so Claude (or any MCP-capable assistant) can inspect and edit a project with your approval.
- **Export your way.** WAV / MP3 with chapters, timecodes for YouTube, and video through your own [templates](docs/TEMPLATES.md).
- **Local first.** Transcription runs on your own GPU with Whisper; your recordings never leave your computer unless you choose to.

## Planned architecture

| Part | Tech | Role |
|---|---|---|
| `engine/` | Python, faster-whisper (CUDA), NumPy/SciPy, FFmpeg, FastAPI | Audio analysis & processing, transcription, rendering, local API |
| `engine/src/holos/mcp_server.py` | Python MCP SDK | MCP server on top of the engine — [docs/MCP.md](docs/MCP.md) |
| `app/` | Tauri v2, Next.js | Desktop UI: transcript editor, waveform, processing panel |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

1. **Engine (CLI)** — import → transcribe → detect fillers → edit list → process → export
2. **UI** — transcript editor with waveform
3. **Desktop app** — Tauri packaging for Windows
4. **MCP** — AI assistants can drive the engine

Full list: [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

The project is at a very early stage. Issues and ideas are welcome; pull requests will be easier once the engine API settles.

## License

[MIT](LICENSE) © 2026 Brain From Ukraine

---

## 🇺🇦 Українською

**Holos Studio** — desktop-редактор подкастів, де звук редагується через текст.

> 🚧 **Статус: рання розробка.** Поки нічим не можна користуватися — див. [roadmap](docs/ROADMAP.md).

**Що буде вміти:**

- **Редагування через транскрипт.** Видаляєш слово в тексті — воно вирізається зі звуку з плавним переходом.
- **Пошук сміття.** Слова-паразити («еее», «ммм»), затинання й повтори підсвічуються, а рішення, що різати, лишається за тобою.
- **Професійна обробка голосу в один клік.** Вдихи, довгі паузи, de-click, de-ess, EQ, компресія, гучність `-16 LUFS`.
- **Неруйнівне редагування.** Оригінальні записи ніколи не змінюються.
- **AI через MCP.** Claude чи інший AI-асистент може працювати з проєктом з твого дозволу.
- **Локально.** Розпізнавання мови працює на твоїй відеокарті, тож записи не залишають комп'ютер.

Проєкт від каналу [Brain From Ukraine](https://github.com/BrainFromUkraine). Ліцензія — [MIT](LICENSE).
