var util = require('util');

/**
 * This implements an HTTP error code that should eventually be passed through
 * next() to an error handling middleware.
 *
 * @param {String} description - a custom description to be sent to the client
 *
 * @example
 * // import the error into a controller
 * const NotFound = require('lib/errors/NotFound');
 *
 * // use the error in either a promise chain or directly via next()
 * return next(new NotFound('Some description...'));
 *
 * @constructor
 */
function NotFound(description) {
  'use strict';

  // make sure we have a working stack trace
  Error.captureStackTrace(this, this.constructor);

  // HTTP status code
  this.status = 404;

  // bhima status code (for $translation)
  this.code = 'ERRORS.NOT_FOUND';

  // default to an empty string if no description passed in
  this.description = description || '';
}

// prototypically inherit from the global error object
util.inherits(NotFound, Error);

// expose the function to an external controller
module.exports = NotFound;