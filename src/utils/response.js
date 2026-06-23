function successResponse(res, data = null, message = 'Success') {
  return res.json({ status: 'SUCCESS', message, data });
}

function errorResponse(res, statusCode, errorCode, failReason) {
  return res.status(statusCode).json({ errorCode, failReason });
}

function setupCredentialsResponse(res, data = null) {
  return res.json({ status: 'SETUP_CREDENTIALS', message: 'Setup required', data });
}

module.exports = { successResponse, errorResponse, setupCredentialsResponse };
