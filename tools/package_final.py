#!/usr/bin/env python3
"""Package the offline viewer and a clean project archive using only Python stdlib."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FINAL = ROOT / 'final'
VIEWER_README = '''КОМНАТА — ПРОГУЛКА В БРАУЗЕРЕ

1. Полностью распакуйте ZIP.
2. Откройте room-walkthrough.html в обычном настольном браузере и нажмите «Начать прогулку».
   На Mac проверен Chrome. Если двойной щелчок открывает редактор, используйте «Открыть с помощью» → браузер.
3. WASD / стрелки — идти; физические клавиши работают и при русской раскладке.
4. Удерживайте левую кнопку мыши или нажмите и тяните трекпад — поворот; можно смотреть вверх и вниз.
5. «Управлять мышью» — свободный поворот, Esc — вернуть курсор. При отказе используйте перетаскивание.
6. Четыре точки обзора слева быстро перемещают по комнате; «План комнаты» показывает положение.
7. «Осмотр» — общий вид без потолка: тяните для вращения, колесо/жест — приближение.
8. «Прогулка» возвращает внутрь; ↺ — в начало; ? — помощь.

Интернет, учётная запись, сервер, Blender, Node.js и установка приложения не нужны.
Стены и закрытые двери ограничивают ходьбу. Двери в этой версии не открываются.
Открывайте HTML в браузере, а не в предпросмотре ZIP, почты или мессенджера.
Для основного качества нужен WebGL2; при его отсутствии включается упрощённый запасной режим.
'''
ALLOWED_DIRS = {'src', 'assets', 'source', 'tools', 'tests', 'verification', 'artifacts', 'dist', 'docs', 'references'}
ALLOWED_FILES = {'.gitignore', 'README.md', 'CODEX_REMAINING.txt', 'START_HERE.txt',
                 'SOURCE_VERSION.txt', 'CODEX_PROMPT.txt', 'OPEN_FIRST.txt',
                 'package.json', 'package-lock.json', 'build.mjs'}
EXCLUDED = {'node_modules', '.git', '.openai', '.DS_Store', '__pycache__', '.env'}

def main():
    FINAL.mkdir(exist_ok=True)
    html = ROOT / 'artifacts/room-walkthrough.html'
    if not html.is_file():
        raise SystemExit('Run npm ci, npm test, npm run build first.')
    with zipfile.ZipFile(FINAL / 'room-for-viewing.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(html, 'room-walkthrough.html')
        z.writestr('README.txt', VIEWER_README)
    with zipfile.ZipFile(FINAL / 'room-for-viewing.zip') as z:
        assert z.namelist() == ['room-walkthrough.html', 'README.txt']
        assert z.testzip() is None
        assert z.read('room-walkthrough.html') == html.read_bytes()
    with zipfile.ZipFile(FINAL / 'room-project-updated.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for file in sorted(ROOT.rglob('*')):
            if not file.is_file() or file.is_symlink():
                continue
            relative = file.relative_to(ROOT)
            if relative.parts[0] not in ALLOWED_DIRS and str(relative) not in ALLOWED_FILES:
                continue
            if any(p in EXCLUDED or p.startswith('.env.') for p in relative.parts):
                continue
            if file.suffix in {'.pyc', '.log'}:
                continue
            z.write(file, 'temka3-room-walkthrough/' + relative.as_posix())
    with zipfile.ZipFile(FINAL / 'room-project-updated.zip') as z:
        assert z.testzip() is None
        assert z.read('temka3-room-walkthrough/source/temka2.blend') == (ROOT / 'source/temka2.blend').read_bytes()
    for name in ['room-for-viewing.zip', 'room-project-updated.zip']:
        data = (FINAL / name).read_bytes()
        print(json.dumps({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))

if __name__ == '__main__':
    main()
