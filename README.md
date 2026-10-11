# Holos Studio

**A podcast editor that does the rough work for you.** Record your podcast, drop in the files and get an almost finished episode. You only review the result and polish the details.

> 🚧 **Status: early version.** Runs on Windows from source; an installer with automatic updates is on the way. See the [roadmap](docs/ROADMAP.md) and [what's new](CHANGELOG.md).

*Holos* (Голос) means "voice" in Ukrainian.

## How it works

1. **New project.** Drop in your recordings; they are copied into the project folder.
2. **Automatic pass.**
   - Files are joined in order.
   - Pauses longer than X are shortened to Y (both thresholds are adjustable).
   - Mouth clicks are removed, breaths are softened.
   - Repeats and re-recorded takes are cut.
   - Loudness is brought to the podcast standard (−16 LUFS).
3. **Editor.** A track with the cuts already closed, and every splice visible: listen to it, restore it or move it. Blade, range selection, markers, and Ctrl+Z for everything.
4. **Export.**
   - Audio only: WAV / MP3 with chapters.
   - Or video through your own template, with a live preview.
   - Plus timecodes for YouTube.
5. **Claude via MCP.** Makes timecodes and edits on request; everything it changes can be undone. Setup: [docs/MCP.md](docs/MCP.md).

## Principles

- Original recordings are never modified.
- Everything runs locally on your own computer.
- Every action can be undone.

## Requirements

- Windows 10 / 11
- NVIDIA GPU with CUDA — recommended. Without one the program runs on the CPU, but speech recognition is much slower (tens of minutes for an hour of audio instead of a minute or two).

## Run from source

```powershell
# terminal 1 — engine
cd engine
uv sync --extra asr --extra gpu --extra video
uv run holos serve --dev

# terminal 2 — app
cd app
npm install
npm run tauri dev
```

Needs [uv](https://docs.astral.sh/uv/), [Node.js](https://nodejs.org), [Rust](https://rustup.rs) and [FFmpeg](https://ffmpeg.org) on `PATH`.

## Inside

| Part | Tech | Role |
|---|---|---|
| `engine/` | Python, faster-whisper (CUDA), NumPy/SciPy, FFmpeg, FastAPI | Analysis, automatic editing, voice processing, rendering, local API — [engine/README.md](engine/README.md) |
| `engine/src/holos/mcp_server.py` | Python MCP SDK | Tools for Claude and other MCP clients — [docs/MCP.md](docs/MCP.md) |
| `app/` | Tauri v2, Next.js | Desktop app: projects, editor, automation settings, export |

More: [architecture](docs/ARCHITECTURE.md) · [design](docs/DESIGN.md) · [video templates](docs/TEMPLATES.md).

## Contributing

The project is at an early stage. Issues and ideas are welcome.

## License

[MIT](LICENSE) © 2026 Brain From Ukraine

---

## 🇺🇦 Українською

**Holos Studio — редактор подкастів, який робить чорнову роботу за тебе.** Записав подкаст, кинув файли — і отримав майже готовий випуск. Ти лише переглядаєш результат і доводиш дрібниці.

> 🚧 **Статус: рання версія.** Працює на Windows із вихідного коду; інсталятор з автооновленням — на підході. Що нового — у [CHANGELOG.md](CHANGELOG.md).

### Як це працює

1. **Новий проєкт.** Перетягуєш записи, вони копіюються в папку проєкту.
2. **Автоматична обробка.**
   - Файли склеюються по порядку.
   - Паузи довші за X скорочуються до Y (пороги налаштовуються).
   - Клацання слини прибираються, вдихи приглушуються.
   - Повтори й перезаписані дублі вирізаються.
   - Гучність вирівнюється до −16 LUFS.
3. **Редактор.** Доріжка, на якій вирізи вже закриті, і кожну склейку видно: послухати, відновити, посунути. Лезо, виділення діапазону, маркери, Ctrl+Z на все.
4. **Експорт.**
   - Тільки аудіо: WAV / MP3 з розділами.
   - Або відео за твоїм шаблоном, з живим прев'ю.
   - Плюс таймкоди для YouTube.
5. **Claude через MCP.** Робить таймкоди і правки на твоє прохання, усе скасовується.

### Принципи

- Оригінали не змінюються.
- Все працює локально, на твоєму комп'ютері.
- Будь-яку дію можна скасувати.

### Вимоги

- Windows 10 / 11
- Відеокарта NVIDIA з CUDA — рекомендована. Без неї програма працює на процесорі, але розпізнавання мови значно повільніше (десятки хвилин на годину запису замість однієї-двох).

Проєкт від каналу [Brain From Ukraine](https://github.com/BrainFromUkraine). Ліцензія — [MIT](LICENSE).
