/**
 * Diagnostic code constants for semantic validation.
 *
 * These string codes are attached to LSP Diagnostic objects so that code action
 * handlers can identify which quick-fix to offer for a given diagnostic.
 */

export const DIAG_CLASS_NOT_FOUND = 'class-not-found';
export const DIAG_OBSERVER_CLASS_NOT_FOUND = 'observer-class-not-found';
export const DIAG_SERVICE_CLASS_NOT_FOUND = 'service-class-not-found';
export const DIAG_MODEL_CLASS_NOT_FOUND = 'model-class-not-found';
export const DIAG_TEMPLATE_NOT_FOUND = 'template-not-found';
export const DIAG_OBSERVER_MISSING_INTERFACE = 'observer-missing-interface';
export const DIAG_DUPLICATE_PLUGIN_NAME = 'duplicate-plugin-name';
export const DIAG_ACL_RESOURCE_NOT_FOUND = 'acl-resource-not-found';
export const DIAG_METHOD_NOT_FOUND = 'method-not-found';
export const DIAG_MODULE_NOT_ACTIVE = 'module-not-active';
export const DIAG_FK_TABLE_NOT_FOUND = 'fk-table-not-found';
export const DIAG_FK_COLUMN_NOT_FOUND = 'fk-column-not-found';
