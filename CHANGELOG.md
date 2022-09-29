# Changelog

## 0.1.0

* Change the name of `img` directory to `resources` to adopt the [loading resouces feature](https://nodered.org/docs/creating-nodes/resources) which is available since Node-RED 1.3.
    * Caution: If you're using resources of `img` directory of old version package in your flows to make custom endpoints, please modify those flows and URLs.
* Add new manipulator `GX-4`, `GX-8`, `T-3B`, `T-6B` support
* Add input validation to name, host, and password fields on the edit dialog of the status-monitor node
* Improvement of communication stability between the status-monitor node and the controller

## 0.0.1

* Initial release
