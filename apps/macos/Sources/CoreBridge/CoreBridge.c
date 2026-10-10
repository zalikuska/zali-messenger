// Намеренно пустой. CoreBridge — модуль только с заголовком (include/CoreBridge.h),
// но у clang-таргета без единого исходника нет объектного файла, а новый
// swiftbuild-бэкенд SwiftPM всё равно ставит CoreBridge.o в список линковки и
// падает с «Build input file cannot be found». Пустая единица трансляции
// даёт этому .o появиться.
#include "CoreBridge.h"
