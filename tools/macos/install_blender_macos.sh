#!/bin/bash
# Локальная установка официальной Blender на Mac. Bash 3.2, без Homebrew и sudo.
# Версии проверены по официальным индексам Blender 9 ноября 2026 года.
# Ни .blend, ни пользовательские настройки этим скриптом не открываются/изменяются.
set -u
set -o pipefail

macinstall_force_selected=0
macinstall_tmp=""
macinstall_device=""
macinstall_target=""
macinstall_owns_partial_target=0
macinstall_newer_probe=""
macinstall_newer_version=""

macinstall_usage() {
    printf '%s\n' \
      'Установка официальной Blender в ~/Applications без sudo и Homebrew.' \
      '  bash tools/macos/install_blender_macos.sh' \
      '  bash tools/macos/install_blender_macos.sh --install-selected' \
      '' \
      'Повторно используется стабильная версия той же выбранной ветки с не меньшим patch:' \
      '5.2.3+ в ветке 5.2 либо 4.5.15+ в ветке 4.5, в зависимости от Mac.' \
      'Более старые версии сохраняются; выбранная версия устанавливается отдельно.' \
      'При обнаружении более новой стабильной ветки сначала нужна диагностика проекта;' \
      'установщик по умолчанию не добавляет рядом старую ветку автоматически.' \
      '--install-selected устанавливает отдельную выбранную версию даже при наличии другой.' \
      'Существующая папка Blender-VERSION.app никогда не перезаписывается.' \
      'Apple Silicon + macOS 13+: 5.2.3 LTS ARM64.' \
      'Intel или macOS 11.2–12: 4.5.15 LTS соответствующей архитектуры.' \
      'Ветка 4.5 может открыть исходник 5.2.3 с потерей новых функций, включая Geometry Nodes.' \
      'Её результат нужно сравнить с baseline room.glb и native_audit; полный экспорт не гарантирован.' \
      'Проверяются официальный SHA256, подпись приложения и оценка Gatekeeper.' \
      'Защита macOS не отключается. Модель автоматически не открывается.'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) macinstall_usage; exit 0 ;;
        --install-selected) macinstall_force_selected=1; shift ;;
        *) printf 'Неизвестный параметр: %s\n' "$1" >&2; macinstall_usage >&2; exit 2 ;;
    esac
done

macinstall_system="$(uname -s)"
if [ "$macinstall_system" != 'Darwin' ]; then
    printf 'Обнаружена %s. Установщик работает только на самом Mac.\n' "$macinstall_system"
    printf '%s\n' 'Ничего не скачано и не установлено. Запустите скрипт через локальный Codex на Mac.'
    exit 2
fi
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    printf '%s\n' 'Не найден домашний каталог пользователя; установка остановлена.' >&2
    exit 2
fi

macinstall_os="$(sw_vers -productVersion)"
macinstall_machine="$(uname -m)"
macinstall_arm64="$(sysctl -n hw.optional.arm64 2>/dev/null || printf '0')"
macinstall_rosetta="$(sysctl -n sysctl.proc_translated 2>/dev/null || printf '0')"
macinstall_major_os="${macinstall_os%%.*}"
macinstall_rest_os="${macinstall_os#*.}"
macinstall_minor_os="${macinstall_rest_os%%.*}"
case "$macinstall_major_os:$macinstall_minor_os" in
    *[!0-9:]*|:*|*:) printf 'Неизвестный формат macOS: %s\n' "$macinstall_os" >&2; exit 2 ;;
esac
if [ "$macinstall_major_os" -lt 11 ] || { [ "$macinstall_major_os" -eq 11 ] && [ "$macinstall_minor_os" -lt 2 ]; }; then
    printf 'macOS %s старее минимальной 11.2 для выбранных версий.\n' "$macinstall_os" >&2
    printf '%s\n' 'Нужна отдельная проверка совместимости; установка не выполнена.' >&2
    exit 2
fi

macinstall_arch='x64'
if [ "$macinstall_arm64" = '1' ] || [ "$macinstall_machine" = 'arm64' ] || [ "$macinstall_rosetta" = '1' ]; then
    macinstall_arch='arm64'
fi
macinstall_version='4.5.15'
macinstall_branch='4.5'
if [ "$macinstall_arch" = 'arm64' ] && [ "$macinstall_major_os" -ge 13 ]; then
    macinstall_version='5.2.3'
    macinstall_branch='5.2'
fi
printf 'Mac: macOS %s; аппаратная архитектура %s.\n' "$macinstall_os" "$macinstall_arch"
[ "$macinstall_rosetta" != '1' ] || printf '%s\n' 'Обнаружена Rosetta; будет загружена родная ARM64-сборка.'
printf 'Выбран стабильный выпуск Blender %s LTS.\n' "$macinstall_version"
if [ "$macinstall_arch" = 'x64' ]; then
    printf '%s\n' 'Для Intel также требуется совместимая графика Metal 2.2; полный графический тест выполняется после установки.'
fi
if [ "$macinstall_branch" = '4.5' ]; then
    printf '%s\n' \
      'Исходная модель создана в Blender 5.2.3 и использует Geometry Nodes Array.' \
      'Ветка 4.5 может открыть её с потерей новых функций; полный корректный экспорт не гарантирован.' \
      'Перед использованием сравните геометрию с baseline room.glb и отчётом native_audit.'
fi

macinstall_target="$HOME/Applications/Blender-$macinstall_version.app"
macinstall_required_major="${macinstall_branch%%.*}"
macinstall_required_minor="${macinstall_branch#*.}"
macinstall_required_patch="${macinstall_version##*.}"

# Повторно используем только стабильную выбранную ветку с patch >= закреплённого.
# Старую ветку сохраняем; более новую отмечаем для диагностики без автоматического downgrade.
# Даже совместимость ветки не заменяет визуальную проверку экспорта модели.
macinstall_check_existing() {
    local macinstall_probe="$1"
    local macinstall_text macinstall_version_line macinstall_v macinstall_maj macinstall_min macinstall_pat macinstall_tail
    [ -f "$macinstall_probe" ] && [ -x "$macinstall_probe" ] || return 1
    macinstall_text="$("$macinstall_probe" --version 2>&1)" || return 1
    # Blender dependencies may write startup warnings before the version banner.
    # Inspect the actual Blender line; e.g. ARCH_CACHE_LINE_SIZE contains "RC".
    macinstall_version_line="$(printf '%s\n' "$macinstall_text" | awk '/^Blender [0-9]+\./ { print; exit }')"
    case "$macinstall_version_line" in *Alpha*|*Beta*|*alpha*|*beta*|*Candidate*|*candidate*|*RC*) return 1 ;; esac
    macinstall_v="$(printf '%s\n' "$macinstall_text" | awk '/^Blender [0-9]+\./ { print $2; exit }')"
    macinstall_maj="${macinstall_v%%.*}"
    macinstall_tail="${macinstall_v#*.}"
    macinstall_min="${macinstall_tail%%.*}"
    [ "$macinstall_tail" != "$macinstall_min" ] || return 1
    macinstall_pat="${macinstall_tail#*.}"
    case "$macinstall_maj:$macinstall_min:$macinstall_pat" in *[!0-9:]*|:*|*::*|*:) return 1 ;; esac
    if [ "$macinstall_maj" -gt "$macinstall_required_major" ] \
       || { [ "$macinstall_maj" -eq "$macinstall_required_major" ] && [ "$macinstall_min" -gt "$macinstall_required_minor" ]; }; then
        macinstall_newer_probe="$macinstall_probe"
        macinstall_newer_version="$macinstall_v"
        printf 'Найдена более новая стабильная ветка %s: %s\n' "$macinstall_v" "$macinstall_probe"
        return 1
    fi
    if [ "$macinstall_maj" -ne "$macinstall_required_major" ] \
       || [ "$macinstall_min" -ne "$macinstall_required_minor" ] \
       || [ "$macinstall_pat" -lt "$macinstall_required_patch" ]; then
        printf 'Сохраняю более старую установленную Blender %s: %s\n' "$macinstall_v" "$macinstall_probe"
        printf 'Для воспроизводимой обработки выбрана отдельная Blender %s.\n' "$macinstall_version"
        return 1
    fi
    printf 'Уже доступна %s\n' "$macinstall_version_line"
    printf 'Бинарник: %s\n' "$macinstall_probe"
    printf '%s\n' \
      'Это стабильная выбранная ветка с подходящим patch; повторная установка пропущена.' \
      'Корректность чтения и экспорта модели проверяется отдельно по baseline.'
    printf 'Проверенная команда: %q --version\n' "$macinstall_probe"
    return 0
}

if [ -e "$macinstall_target" ] || [ -L "$macinstall_target" ]; then
    if macinstall_check_existing "$macinstall_target/Contents/MacOS/Blender"; then
        exit 0
    fi
    printf 'Целевой путь уже существует и не будет заменён: %s\n' "$macinstall_target" >&2
    printf '%s\n' 'Проверьте его вручную; установщик не удаляет существующие приложения.' >&2
    exit 3
fi
if [ "$macinstall_force_selected" -eq 0 ]; then
    for macinstall_bundle in /Applications/Blender*.app "$HOME"/Applications/Blender*.app; do
        if macinstall_check_existing "$macinstall_bundle/Contents/MacOS/Blender"; then
            printf '%s\n' 'Чтобы отдельно установить выбранный выпуск, повторите с --install-selected.'
            exit 0
        fi
        if macinstall_check_existing "$macinstall_bundle/Contents/MacOS/blender"; then
            exit 0
        fi
    done
    for macinstall_command in blender Blender; do
        macinstall_path_bin="$(command -v "$macinstall_command" 2>/dev/null || true)"
        if [ -n "$macinstall_path_bin" ] && macinstall_check_existing "$macinstall_path_bin"; then
            exit 0
        fi
    done
    if [ -n "$macinstall_newer_probe" ]; then
        printf '\nУже найдена стабильная Blender %s более новой ветки.\n' "$macinstall_newer_version"
        printf '%s\n' \
          'Проверка --version прошла; совместимость проекта с этой веткой ещё не проверена.' \
          'Сначала проверьте в ней модель, Geometry Nodes и соответствие baseline room.glb/native_audit.' \
          'По умолчанию более старая ветка рядом не устанавливается.' \
          'Если для воспроизводимости нужен именно закреплённый выпуск, повторите с --install-selected.' \
          'Ничего не скачано и не изменено; код 10 означает необходимость этой диагностики.'
        exit 10
    fi
fi

for macinstall_tool in /usr/bin/curl /usr/bin/shasum /usr/bin/hdiutil /usr/libexec/PlistBuddy /usr/bin/ditto /usr/bin/codesign /usr/sbin/spctl; do
    if [ ! -x "$macinstall_tool" ]; then
        printf 'Отсутствует штатная утилита: %s\n' "$macinstall_tool" >&2
        exit 4
    fi
done

macinstall_cleanup() {
    local macinstall_status="$?"
    trap - EXIT INT TERM
    if [ "$macinstall_owns_partial_target" -eq 1 ] && [ -n "$macinstall_target" ]; then
        printf '%s\n' 'Удаляю только незавершённую копию, созданную этим запуском.' >&2
        /bin/rm -rf "$macinstall_target"
    fi
    if [ -n "$macinstall_device" ]; then
        if ! /usr/bin/hdiutil detach "$macinstall_device" -quiet; then
            printf 'Не удалось автоматически отключить образ %s; извлеките его через Finder.\n' "$macinstall_device" >&2
        fi
    fi
    if [ -n "$macinstall_tmp" ] && [ -d "$macinstall_tmp" ]; then
        /bin/rm -rf "$macinstall_tmp"
    fi
    exit "$macinstall_status"
}
trap macinstall_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
macinstall_tmp="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/blender-room-install.XXXXXXXX")" || exit 4
macinstall_name="blender-$macinstall_version-macos-$macinstall_arch.dmg"
macinstall_base="https://download.blender.org/release/Blender$macinstall_branch"
macinstall_dmg="$macinstall_tmp/$macinstall_name"
macinstall_checksums="$macinstall_tmp/blender-$macinstall_version.sha256"
printf 'Получаю официальный SHA256: %s/blender-%s.sha256\n' "$macinstall_base" "$macinstall_version"
if ! /usr/bin/curl --fail --location --show-error --silent --retry 2 --connect-timeout 30 --max-time 180 \
    --proto '=https' --proto-redir '=https' \
    "$macinstall_base/blender-$macinstall_version.sha256" --output "$macinstall_checksums"; then
    printf '%s\n' 'Не удалось получить контрольные суммы; установка остановлена.' >&2
    exit 5
fi
macinstall_expected="$(/usr/bin/awk -v wanted="$macinstall_name" '{ name=$2; sub(/^\*/, "", name); if (name==wanted && length($1)==64 && $1 ~ /^[0-9a-fA-F]+$/) print tolower($1) }' "$macinstall_checksums")"
if [ "${#macinstall_expected}" -ne 64 ]; then
    printf '%s\n' 'В официальном списке не найдена однозначная SHA256 для выбранного DMG.' >&2
    exit 5
fi
printf 'Скачиваю официальный образ: %s/%s\n' "$macinstall_base" "$macinstall_name"
printf '%s\n' 'Размер около 300–350 МБ; скорость зависит от соединения.'
if ! /usr/bin/curl --fail --location --show-error --progress-bar --retry 2 --connect-timeout 30 --max-time 1800 \
    --proto '=https' --proto-redir '=https' \
    "$macinstall_base/$macinstall_name" --output "$macinstall_dmg"; then
    printf '%s\n' 'Не удалось скачать образ; установка остановлена.' >&2
    exit 5
fi
if ! macinstall_actual="$(/usr/bin/shasum -a 256 "$macinstall_dmg" | /usr/bin/awk '{ print tolower($1) }')"; then
    printf '%s\n' 'Не удалось вычислить SHA256 скачанного файла.' >&2
    exit 5
fi
if [ "$macinstall_actual" != "$macinstall_expected" ]; then
    printf '%s\n' 'SHA256 не совпала. Образ не будет подключён; загрузка будет удалена.' >&2
    exit 5
fi
printf '%s\n' 'SHA256 совпала с опубликованной Blender.'

macinstall_plist="$macinstall_tmp/mount.plist"
macinstall_attach_status=0
/usr/bin/hdiutil attach -readonly -nobrowse -plist "$macinstall_dmg" > "$macinstall_plist" || macinstall_attach_status=$?
macinstall_index=0
macinstall_source_app=""
while /usr/libexec/PlistBuddy -c "Print :system-entities:$macinstall_index" "$macinstall_plist" >/dev/null 2>&1; do
    macinstall_entity_device="$(/usr/libexec/PlistBuddy -c "Print :system-entities:$macinstall_index:dev-entry" "$macinstall_plist" 2>/dev/null || true)"
    if [ -z "$macinstall_device" ] && [ -n "$macinstall_entity_device" ]; then
        macinstall_device="$macinstall_entity_device"
    fi
    macinstall_mount="$(/usr/libexec/PlistBuddy -c "Print :system-entities:$macinstall_index:mount-point" "$macinstall_plist" 2>/dev/null || true)"
    if [ -n "$macinstall_mount" ] && [ -d "$macinstall_mount/Blender.app" ]; then
        macinstall_source_app="$macinstall_mount/Blender.app"
    fi
    macinstall_index=$((macinstall_index + 1))
done
if [ "$macinstall_attach_status" -ne 0 ] || [ -z "$macinstall_source_app" ] || [ -z "$macinstall_device" ]; then
    printf '%s\n' 'Не удалось подключить образ или найти в нём Blender.app.' >&2
    exit 6
fi

printf '%s\n' 'Проверяю подпись приложения и разрешение Gatekeeper.'
if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$macinstall_source_app"; then
    printf '%s\n' 'Подпись не прошла проверку. Приложение не будет установлено.' >&2
    exit 7
fi
if ! /usr/sbin/spctl --assess --type execute --verbose=2 "$macinstall_source_app"; then
    printf '%s\n' \
      'macOS не одобрила приложение. Установка остановлена, защита не изменена.' \
      'Проверьте сообщение macOS, официальный источник и доступность проверки notarization.' >&2
    exit 7
fi

/bin/mkdir -p "$HOME/Applications" || exit 8
# Атомарно занимаем новый путь. Существующая папка, файл или symlink не заменяются.
if ! /bin/mkdir "$macinstall_target"; then
    printf 'Путь уже появился или недоступен; копирование отменено: %s\n' "$macinstall_target" >&2
    exit 8
fi
macinstall_owns_partial_target=1
printf 'Устанавливаю в %s\n' "$macinstall_target"
if ! /usr/bin/ditto "$macinstall_source_app" "$macinstall_target"; then
    printf '%s\n' 'Копирование не завершено.' >&2
    exit 8
fi
if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$macinstall_target"; then
    printf '%s\n' 'Подпись скопированного приложения не прошла проверку.' >&2
    exit 8
fi
macinstall_binary="$macinstall_target/Contents/MacOS/Blender"
if ! macinstall_run_output="$("$macinstall_binary" --version 2>&1)"; then
    printf '%s\n' 'Установленная копия не прошла --version:' >&2
    printf '%s\n' "$macinstall_run_output" >&2
    exit 9
fi
macinstall_installed_version="$(printf '%s\n' "$macinstall_run_output" | /usr/bin/awk '/^Blender [0-9]+\./ { print $2; exit }')"
if [ "$macinstall_installed_version" != "$macinstall_version" ]; then
    printf 'Получена неожиданная версия %s вместо %s.\n' "$macinstall_installed_version" "$macinstall_version" >&2
    exit 9
fi
macinstall_owns_partial_target=0
printf '\nУстановлена Blender %s. Команда --version выполнена успешно.\n' "$macinstall_version"
printf 'Приложение: %s\n' "$macinstall_target"
printf '%s\n' 'Для запуска интерфейса выполните:'
printf '  open -n -a %q\n' "$macinstall_target"
printf '%s\n' 'Для последующего экспорта используйте бинарник:'
printf '  %q\n' "$macinstall_binary"
printf '%s\n' \
  'Графический интерфейс и модель этим скриптом не запускались.' \
  'Первый запуск интерфейса macOS может потребовать обычного системного подтверждения.' \
  'Gatekeeper и пользовательские настройки не изменялись.'
