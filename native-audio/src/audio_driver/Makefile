#
# Makefile for HAL AudioServerPlugIn Driver
#

DRIVER_NAME = GrowhutAudioDriver
DRIVER_BUNDLE = $(DRIVER_NAME).driver
BUILD_DIR = ../../../build
BUNDLE_DIR = $(BUILD_DIR)/$(DRIVER_BUNDLE)
CONTENTS_DIR = $(BUNDLE_DIR)/Contents
MACOS_DIR = $(CONTENTS_DIR)/MacOS
RESOURCES_DIR = $(CONTENTS_DIR)/Resources

# Source files
SOURCES = audio_driver.c \
          audio_driver_complete.c \
          audio_driver_properties.c \
          main.c

# Compiler flags
CC = clang
CFLAGS = -std=c11 -fPIC -Wall -Wextra -O2
FRAMEWORKS = -framework CoreAudio -framework CoreFoundation -framework IOKit
INCLUDES = -I. -I/System/Library/Frameworks/CoreAudio.framework/Headers

# Installation directory
INSTALL_DIR = /Library/Audio/Plug-Ins/HAL

.PHONY: all clean install uninstall

all: $(BUNDLE_DIR)

$(BUNDLE_DIR): $(MACOS_DIR)/$(DRIVER_NAME) $(CONTENTS_DIR)/Info.plist
	@echo "✅ Driver bundle created: $(BUNDLE_DIR)"

$(MACOS_DIR)/$(DRIVER_NAME): $(SOURCES) audio_driver.h
	@echo "🔨 Building driver executable..."
	@mkdir -p $(MACOS_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) $(FRAMEWORKS) -dynamiclib \
		-install_name "@rpath/$(DRIVER_NAME)" \
		-compatibility_version 1.0.0 \
		-current_version 1.0.0 \
		-o $(MACOS_DIR)/$(DRIVER_NAME) \
		$(SOURCES)

$(CONTENTS_DIR)/Info.plist: Info.plist
	@mkdir -p $(CONTENTS_DIR)
	@cp Info.plist $(CONTENTS_DIR)/Info.plist

clean:
	@echo "🧹 Cleaning build directory..."
	@rm -rf $(BUNDLE_DIR)

install: $(BUNDLE_DIR)
	@echo "📦 Installing driver..."
	@sudo cp -R $(BUNDLE_DIR) $(INSTALL_DIR)/
	@sudo chown -R root:wheel $(INSTALL_DIR)/$(DRIVER_BUNDLE)
	@sudo chmod -R 755 $(INSTALL_DIR)/$(DRIVER_BUNDLE)
	@echo "🔄 Restarting CoreAudio daemon..."
	@sudo launchctl kickstart -k system/com.apple.audio.coreaudiod
	@echo "✅ Driver installed to $(INSTALL_DIR)/$(DRIVER_BUNDLE)"

uninstall:
	@echo "🗑️  Uninstalling driver..."
	@sudo rm -rf $(INSTALL_DIR)/$(DRIVER_BUNDLE)
	@echo "🔄 Restarting CoreAudio daemon..."
	@sudo launchctl kickstart -k system/com.apple.audio.coreaudiod
	@echo "✅ Driver uninstalled"

