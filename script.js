/* script.js */
document.addEventListener('DOMContentLoaded', () => {
    // Элементы интерфейса
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const processArea = document.getElementById('process-area');
    const promptOutput = document.getElementById('prompt-output');
    const copyPromptBtn = document.getElementById('copy-prompt-btn');
    const translatedInput = document.getElementById('translated-input');
    const generateBtn = document.getElementById('generate-btn');
    const statusMessage = document.getElementById('status-message');
    const fileListEl = document.getElementById('file-list');
    
    // Элементы управления частями (если промпт очень большой)
    const chunkControls = document.getElementById('chunk-controls');
    const prevChunkBtn = document.getElementById('prev-chunk-btn');
    const nextChunkBtn = document.getElementById('next-chunk-btn');
    const chunkStatus = document.getElementById('chunk-status');

    // Хранилище данных
    let modsData = {}; // { "modid": { en: {}, ru: {}, originalRu: {} } }
    let promptChunks = [];
    let currentChunkIndex = 0;
    
    // Лимит символов для одного сообщения нейросети (~15k символов)
    const CHARS_PER_CHUNK = 15000; 

    // --- Функции UI ---

    function showFeedback(btn, success, msg) {
        const originalText = btn.innerText;
        btn.classList.add(success ? 'btn-success' : 'btn-error');
        btn.innerText = msg || (success ? 'Готово!' : 'Ошибка');
        setTimeout(() => {
            btn.classList.remove('btn-success', 'btn-error');
            btn.innerText = originalText;
        }, 1500);
    }

    function resetUI() {
        modsData = {};
        promptChunks = [];
        fileListEl.innerHTML = '';
        fileListEl.classList.add('hidden');
        processArea.classList.remove('show');
        statusMessage.innerText = '';
        translatedInput.value = '';
        promptOutput.value = '';
    }

    // --- Обработка Drag & Drop ---

    dropZone.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFiles(e.target.files);
    });

    ['dragenter', 'dragover'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    // --- Логика обработки файлов ---

    async function handleFiles(files) {
        resetUI();
        fileListEl.classList.remove('hidden');
        
        const missingTranslationsGlobal = {}; // Соберем все, что нужно перевести
        let validFilesCount = 0;

        for (const file of files) {
            try {
                let result = null;
                
                if (file.name.endsWith('.jar')) {
                    result = await processJar(file);
                } else if (file.name.endsWith('.json')) {
                    // Поддержка простого JSON (если кинули 1 файл)
                    const text = await file.text();
                    result = {
                        modId: file.name.replace('.json', ''),
                        enJson: JSON.parse(text),
                        ruJson: null,
                        missing: JSON.parse(text) // Считаем, что перевести надо все
                    };
                }

                if (result) {
                    const { modId, enJson, ruJson, missing } = result;
                    
                    modsData[modId] = {
                        en: enJson,
                        ru: ruJson,
                        originalRu: ruJson ? JSON.parse(JSON.stringify(ruJson)) : {} // Копия оригинала
                    };

                    const missingCount = Object.keys(missing).length;
                    
                    if (missingCount > 0) {
                        missingTranslationsGlobal[modId] = missing;
                        addFileStatus(file.name, modId, `Нужен перевод: ${missingCount} строк`, 'warn');
                    } else {
                        addFileStatus(file.name, modId, `Перевод полный`, 'ok');
                    }
                    validFilesCount++;
                } else {
                    addFileStatus(file.name, '???', 'Не найден языковой файл (en_us.json)', 'err');
                }

            } catch (e) {
                console.error(e);
                addFileStatus(file.name, 'ERROR', e.message, 'err');
            }
        }

        if (validFilesCount > 0) {
            generatePrompt(missingTranslationsGlobal);
            processArea.classList.add('show');
        } else {
            statusMessage.innerText = "Не удалось найти подходящие файлы.";
        }
    }

    // Парсинг JAR файла
    async function processJar(file) {
        const zip = new JSZip();
        await zip.loadAsync(file);
        
        let modId = null;
        let enPath = null;
        let ruPath = null;

        // Ищем en_us.json и определяем ModID из пути
        // Путь обычно: assets/<modid>/lang/en_us.json
        for (const path in zip.files) {
            if (path.match(/assets\/([^\/]+)\/lang\/en_us\.json$/i)) {
                const parts = path.split('/');
                modId = parts[1];
                enPath = path;
                // Проверяем, есть ли уже русский
                const potentialRu = path.replace('en_us.json', 'ru_ru.json');
                if (zip.files[potentialRu]) ruPath = potentialRu;
                break;
            }
        }

        if (!modId || !enPath) return null;

        const enText = await zip.file(enPath).async('string');
        const enJson = JSON.parse(enText.replace(/^\uFEFF/, '').replace(/\u00A0/g, ' ')); // Чистим мусор
        
        let ruJson = null;
        if (ruPath) {
            const ruText = await zip.file(ruPath).async('string');
            ruJson = JSON.parse(ruText.replace(/^\uFEFF/, '').replace(/\u00A0/g, ' '));
        }

        // Вычисляем, чего не хватает (Delta)
        const missing = {};
        for (const key in enJson) {
            if (!ruJson || !ruJson[key]) {
                missing[key] = enJson[key];
            }
        }

        return { modId, enJson, ruJson, missing };
    }

    function addFileStatus(name, modId, status, type) {
        const div = document.createElement('div');
        div.className = 'file-item';
        div.innerHTML = `
            <div>${name} <span class="mod-id">[${modId}]</span></div>
            <div class="status-${type}">${status}</div>
        `;
        fileListEl.appendChild(div);
    }

    // --- Генерация Промпта ---

    function generatePrompt(missingGlobal) {
        const modIds = Object.keys(missingGlobal);
        if (modIds.length === 0) {
            promptOutput.value = "Все загруженные моды уже полностью переведены! Вы можете нажать 'Скачать', чтобы получить пак с существующими переводами.";
            return;
        }

        promptChunks = [];
        let currentChunkObj = {};
        let currentSize = 0;

        for (const modId of modIds) {
            const modKeys = missingGlobal[modId];
            // Добавляем этот мод в текущий кусок
            currentChunkObj[modId] = modKeys;
            
            // Проверка размера
            const jsonStr = JSON.stringify(currentChunkObj);
            if (jsonStr.length > CHARS_PER_CHUNK) {
                // Если превысили - убираем последний добавленный мод, сохраняем чанк, и начинаем новый
                delete currentChunkObj[modId];
                addPromptChunk(currentChunkObj);
                
                currentChunkObj = {};
                currentChunkObj[modId] = modKeys;
            }
        }
        
        if (Object.keys(currentChunkObj).length > 0) {
            addPromptChunk(currentChunkObj);
        }

        // Обновляем UI
        currentChunkIndex = 0;
        updateChunkDisplay();
        
        if (promptChunks.length > 1) {
            chunkControls.classList.remove('hidden');
        } else {
            chunkControls.classList.add('hidden');
        }
    }

    function addPromptChunk(obj) {
        const jsonStr = JSON.stringify(obj, null, 2);
        const prompt = `Пожалуйста, переведи значения в этом JSON на русский для Minecraft.
СТРУКТУРА: Ключи верхнего уровня ("${Object.keys(obj).join('", "')}") — это ID модов, их НЕ переводи. Внутри — ключи и текст.
ПРАВИЛА:
1. Переводи только значения (текст справа).
2. НЕ меняй спец. символы (%s, %d, §a).
3. Верни только валидный JSON.

${jsonStr}`;
        promptChunks.push(prompt);
    }

    function updateChunkDisplay() {
        if (!promptChunks.length) return;
        promptOutput.value = promptChunks[currentChunkIndex];
        chunkStatus.innerText = `${currentChunkIndex + 1} / ${promptChunks.length}`;
        prevChunkBtn.disabled = currentChunkIndex === 0;
        nextChunkBtn.disabled = currentChunkIndex === promptChunks.length - 1;
    }

    prevChunkBtn.addEventListener('click', () => { currentChunkIndex--; updateChunkDisplay(); });
    nextChunkBtn.addEventListener('click', () => { currentChunkIndex++; updateChunkDisplay(); });

    copyPromptBtn.addEventListener('click', () => {
        if (!promptOutput.value) return;
        navigator.clipboard.writeText(promptOutput.value)
            .then(() => showFeedback(copyPromptBtn, true, 'Скопировано!'))
            .catch(() => showFeedback(copyPromptBtn, false));
    });

    // --- Сборка Ресурс-пака ---

    generateBtn.addEventListener('click', async () => {
        const inputStr = translatedInput.value.trim();
        let translatedData = {};

        // Пытаемся распарсить ввод. Пользователь мог вставить несколько JSON подряд.
        // Используем простой regex для поиска объектов {...} верхнего уровня
        if (inputStr) {
            try {
                // 1. Пробуем распарсить как единый JSON
                translatedData = JSON.parse(inputStr);
            } catch (e) {
                // 2. Если ошибка, пробуем найти отдельные блоки JSON
                const regex = /({[\s\S]*?})(?=\s*{|\s*$)/g;
                let match;
                while ((match = regex.exec(inputStr)) !== null) {
                    try {
                        const part = JSON.parse(match[0]);
                        translatedData = { ...translatedData, ...part };
                    } catch (err) { console.warn("Skip invalid block"); }
                }
            }
        }

        // Создаем ZIP
        const zip = new JSZip();
        
        // 1. Файл описания пака (pack.mcmeta)
        zip.file("pack.mcmeta", JSON.stringify({
            "pack": {
                "pack_format": 15,
                "description": "Generated by MMT Translation Tool"
            }
        }, null, 2));

        let filesAdded = 0;

        // 2. Собираем файлы для каждого мода
        for (const modId in modsData) {
            // Берем старый перевод (если был в jar)
            let finalRu = modsData[modId].originalRu || {};
            
            // Если нейросеть прислала перевод для этого мода, накладываем сверху
            if (translatedData[modId]) {
                Object.assign(finalRu, translatedData[modId]);
            }

            // Добавляем в архив: assets/<modid>/lang/ru_ru.json
            if (Object.keys(finalRu).length > 0) {
                zip.file(`assets/${modId}/lang/ru_ru.json`, JSON.stringify(finalRu, null, 2));
                filesAdded++;
            }
        }

        if (filesAdded === 0) {
            showFeedback(generateBtn, false, 'Нет данных для сохранения');
            return;
        }

        // Скачиваем
        const content = await zip.generateAsync({type:"blob"});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = "MMT_Translations_Pack.zip";
        link.click();
        
        showFeedback(generateBtn, true, 'Скачано!');
    });
});
