// Ukrainian for the automation area (keys = English UI text).
export const automation: Record<string, string | string[]> = {
  // header
  "Automation": "Автоматика",
  "default for new projects": "стандарт для нових проєктів",
  "duration": "тривалість",
  "Back to the editor": "До редактора",
  "Back to the new project": "До нового проєкту",
  "What the app does by itself as soon as you import recordings.": "Що програма робить сама, щойно ви імпортували записи.",
  "Changes here recalculate the episode straight away — you can still adjust each case in the editor, and your manual edits are never overwritten.":
    "Зміна тут одразу перераховує випуск — у редакторі можна підправити кожен окремий випадок; ваші ручні правки не перезаписуються.",
  "Loading…": "Завантажую…",

  // pauses
  "Pauses": "Паузи",
  "{n} shortened": "скорочено {n}",
  "Longer than": "Довші за",
  "s, shorten to": "с скорочувати до",
  "s": "с",
  "Pause threshold, s": "Поріг паузи, с",
  "Length after shortening, s": "Довжина після скорочення, с",
  "Cuts in the middle of the silence with a crossfade, so the rhythm of speech stays natural.":
    "Ріже посередині тиші, з кросфейдом — ритм мови лишається природним.",
  "Crossfade at splices": "Кросфейд на склейках",
  "{n} ms": "{n} мс",

  // mouth clicks
  "Mouth clicks": "Клацання слини й губ",
  "Sensitivity": "Чутливість",
  "Light": "Легко",
  "Normal": "Звичайно",
  "Strong": "Сильно",
  "Finds short isolated clicks and paints over only their high frequencies — nothing is cut and the duration doesn’t change.":
    "Знаходить короткі поодинокі клацання й замальовує лише їхні високі частоти — нічого не вирізається, тривалість не змінюється.",

  // breaths
  "Breaths": "Вдихи",
  "{n} in this episode": "{n} у випуску",
  "What to do with breaths": "Що робити з вдихами",
  "Reduce": "Приглушити",
  "Remove": "Прибрати",
  "By": "На",
  "“Remove” brings them down to room tone, with no hole in the sound.": "«Прибрати» — до рівня тону кімнати, без діри в звуці.",

  // repeats, retakes, fragments
  "Repeats, retakes, fragments": "Повтори, дублі, обірвані фрази",
  "Repeats within a file": "Повтори в одному файлі",
  "Retakes across files": "Дублі між файлами",
  "Fillers (um, uh)": "Слова-паразити (еее, ммм)",
  "Fragments": "Обірвані слова",
  "Unclear speech": "Нерозбірлива мова",
  "Cut": "Вирізати",
  "Keep": "Залишити",
  "Each cut shows up in the editor as a splice — you can listen to it and restore it.":
    "Кожен виріз видно в редакторі як склейку — її можна прослухати й відновити.",

  // loudness
  "Loudness": "Гучність",
  "Loudness preset": "Пресет гучності",
  "Podcast": "Подкаст",
  "Broadcast": "Мовлення",
  "true peak ceiling −2 dBTP": "стеля true peak −2 dBTP",
  "Match levels across files": "Вирівняти рівень між файлами",
  "Fill drop-outs with room tone": "Заповнювати провали фону тоном кімнати",

  // voice processing
  "Voice processing": "Обробка голосу",
  "Low cut": "Зріз низу",
  "75 Hz": "75 Гц",
  "Digital clicks": "Цифрові клацання",
  "Voice EQ": "Еквалайзер голосу",
  "−2 dB at 350 Hz · +2 dB at 3.2 kHz": "−2 dB 350 Гц · +2 dB 3.2 кГц",
  "De-esser": "Де-есер",
  "up to −8 dB": "до −8 dB",
  "Compressor": "Компресор",
  "voice": "голос",
  "Limiter": "Лімітер",

  // footer
  "Applied": "Застосовано",
  "Saved as the default for new projects": "Збережено як стандарт для нових проєктів",
  "Done — back to the editor": "Готово — до редактора",
  "Save as default for new projects": "Зберегти як стандарт для нових",
  "Save defaults": "Зберегти стандарт",
};
