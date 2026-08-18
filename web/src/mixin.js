// ZaliMixin — сборка класса ZaliInterface из доменных частей.
//
// Класс жил одним файлом на 21 500 строк; теперь его тело разложено по
// web/src/interface/*.js. Части подключаются не объектными литералами, а
// class-выражениями — это принципиально:
//   * тела методов переносятся дословно, без запятых между ними, поэтому
//     разбиение не редактирует ни одной строки логики;
//   * копируются дескрипторы, а не значения, поэтому `static get` не
//     вычисляется при переносе, а методы остаются НЕперечисляемыми — ровно
//     как у обычного class-тела (Object.assign сделал бы их перечисляемыми
//     и выполнил бы геттеры);
//   * статические поля части (например VERSION_SCHEME_MIGRATION_CUTOFF_UNIX)
//     переезжают вместе со своими методами.
//
// `super` в частях использовать нельзя: [[HomeObject]] метода указывает на
// прототип анонимного class-выражения, а не на ZaliInterface.
//
// Объявление намеренно верхнеуровневое, а не window.ZaliMixin внутри IIFE:
// бандл — обычный script, все файлы делят одну область видимости, а харнессы
// (scripts/*_doctor) исполняют ту же склейку в vm-контексте, где `window` —
// просто объект и глобальных биндингов не создаёт.
function ZaliMixin(target, part) {
    const STATIC_SKIP = new Set(['length', 'name', 'prototype']);

    const copyMembers = (from, to, label, skip) => {
        for (const key of Reflect.ownKeys(from)) {
            if (skip.has(key)) continue;
            if (Object.prototype.hasOwnProperty.call(to, key)) {
                // В едином class-теле дубликат молча побеждал бы последним и
                // отлаживался бы часами. Поведение сохраняем, но кричим в консоль.
                console.error(`[ZaliMixin] дубликат ${label} "${String(key)}" — побеждает последний`);
            }
            Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key));
        }
    };

    copyMembers(part.prototype, target.prototype, 'метод', new Set(['constructor']));
    copyMembers(part, target, 'статик', STATIC_SKIP);
}

window.ZaliMixin = ZaliMixin;
