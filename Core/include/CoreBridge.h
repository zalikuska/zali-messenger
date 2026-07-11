#ifndef CoreBridge_h
#define CoreBridge_h

#include <stdbool.h>
#include <stddef.h>

bool zali_pack_message(const char* sender, const char* text, const char* output);
bool zali_unpack_message(const char* archive_path, const char* temp_dir, char* out_sender, size_t out_sender_max_len, char* out_text, size_t out_text_max_len);

char* zali_bus_dispatch(const char* address_command, const char* args_json);
void zali_bus_free_string(char* ptr);

#endif /* CoreBridge_h */
