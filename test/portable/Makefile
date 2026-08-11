ROOT := ../..
CXXFLAGS := -std=c++11 -Wall -Wextra -Werror -pedantic \
	-fsanitize=address,undefined -fno-omit-frame-pointer \
	-DALLOY_DEVICE_TESTING -I$(ROOT)/src
SOURCES := $(ROOT)/src/alloy/device/protocol.cpp \
	$(ROOT)/src/alloy/device/core.cpp test_main.cpp
TARGET := /tmp/alloy-device-portable-tests

.PHONY: test
test:
	$(CXX) $(CXXFLAGS) $(SOURCES) -o $(TARGET)
	$(TARGET)
