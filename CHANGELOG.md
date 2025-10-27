# Changelog

All notable changes to this project will be documented in this file. This
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.3.1 (2025-10-27)

- Improve reliability of device communication by re-creating communicator object
  after failed tries

## 1.3.0 (2025-10-09)

- Add support for enabling/disabling device communication error logs regardless
  whether Homebridge Debug Mode is enabled

## 1.2.2 (2025-09-22)

- Revert changelog format
- Add missing changelog entry for release 1.2.1

## 1.2.1 (2025-09-22)

- Improve package visibility & indexing
- Add publishConfig to package.json
- Add `homebridge` keyword to package.json

## 1.2.0 (2025-09-19)

- Rename the plugin name in settings.ts to match the name in package.json
- Fix changelog format for Homebridge UI

## 1.1.0 (2025-09-19)

- Use dropdown for device light option selection in the configuration
- Improve device communication by adding a timeout mechanism for sending a set
  device status command to the device
- Improve documentation wording

## 1.0.0 (2025-09-19)

- Initial release
