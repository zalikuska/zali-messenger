#ifndef CoreBridge_h
#define CoreBridge_h

#include <stdbool.h>

bool zali_pack_message(const char* sender, const char* text, const char* output);

char* zali_bus_dispatch(const char* address_command, const char* args_json);
void zali_bus_free_string(char* ptr);

#endif /* CoreBridge_h */
