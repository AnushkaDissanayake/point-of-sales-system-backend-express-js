function successResponse(res, data = null, message = 'Success') {
  if (data === null || data === undefined) {
    return res.json({ status: 'SUCCESS', message, cooldownMinutes: null });
  }
  if (typeof data === 'number') {
    return res.json({ status: 'SUCCESS', message, cooldownMinutes: data });
  }
  if (Array.isArray(data)) {
    return res.json(data);
  }
  if (typeof data === 'object') {
    if (data.status !== undefined || message === 'Success') {
      return res.json(data);
    }
    return res.json({ status: 'SUCCESS', message, ...data });
  }
  return res.json({ status: 'SUCCESS', message, cooldownMinutes: null, ...data });
}

function errorResponse(res, statusCode, errorCode, failReason) {
  return res.status(statusCode).json({ errorCode, failReason });
}

function setupCredentialsResponse(res, data = null) {
  return res.json({ status: 'SETUP_CREDENTIALS', message: 'Setup required', data });
}

module.exports = { successResponse, errorResponse, setupCredentialsResponse };
