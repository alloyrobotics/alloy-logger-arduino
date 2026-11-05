// AlloyLogger.h — deprecated: the library was renamed to the Alloy Storage SDK in 0.6.0.
// Kept so 0.5 sketches (`#include <AlloyLogger.h>`, `AlloyLogger alloy;`) still compile.
// New code: `#include <AlloyStorage.h>` and `AlloyStorage alloy;`.

#pragma once
#include "AlloyStorage.h"

using AlloyLogger [[deprecated("renamed to AlloyStorage; include <AlloyStorage.h>")]] = AlloyStorage;
