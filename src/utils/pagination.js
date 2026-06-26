function buildPaginatedQuery(baseQuery, countQuery, params, page, size, sorting, filterColumn, operator, filterValue, allowedColumns) {
  const validOperators = {
    'EQUALS': '=',
    'NOT_EQUALS': '!=',
    'CONTAINS': 'LIKE',
    'STARTS_WITH': 'LIKE',
    'ENDS_WITH': 'LIKE',
    'GREATER_THAN': '>',
    'LESS_THAN': '<',
    'GREATER_THAN_OR_EQUALS': '>=',
    'LESS_THAN_OR_EQUALS': '<=',
    'like': 'LIKE',
    'LIKE': 'LIKE',
    '=': '='
  };

  let whereClause = '';
  let filterParams = [];

  if (filterColumn && operator && filterValue !== undefined && filterValue !== '') {
    const sqlOp = validOperators[operator] || (operator.toUpperCase() === 'LIKE' ? 'LIKE' : null);
    let safeColumn = allowedColumns && allowedColumns.includes(filterColumn) ? filterColumn : null;
    if (safeColumn && !safeColumn.includes('.')) {
      const prefixed = allowedColumns.find(c => c.endsWith(`.${safeColumn}`));
      if (prefixed) {
        safeColumn = prefixed;
      }
    }

    if (sqlOp && safeColumn) {
      let val = filterValue;
      if (operator === 'CONTAINS' || operator.toLowerCase() === 'like') {
        val = `%${filterValue}%`;
      } else if (operator === 'STARTS_WITH') {
        val = `${filterValue}%`;
      } else if (operator === 'ENDS_WITH') {
        val = `%${filterValue}`;
      }

      const isIdCol = safeColumn.endsWith('_id') || safeColumn === 'id' || safeColumn.endsWith('.id');
      if (isIdCol) {
        whereClause = ` AND ${safeColumn} = ?`;
        val = parseInt(String(val).replace(/%/g, '')) || 0;
      } else {
        whereClause = ` AND LOWER(${safeColumn}) ${sqlOp} ?`;
        val = String(val).toLowerCase();
      }
      filterParams = [val];
    }
  }

  let orderClause = '';
  if (sorting) {
    const [col, dir] = sorting.split(',');
    let safeCol = allowedColumns && allowedColumns.includes(col) ? col : null;
    if (safeCol && !safeCol.includes('.')) {
      const prefixed = allowedColumns.find(c => c.endsWith(`.${safeCol}`));
      if (prefixed) {
        safeCol = prefixed;
      }
    }
    if (safeCol) {
      const safeDir = (dir && dir.toUpperCase() === 'DESC') ? 'DESC' : 'ASC';
      orderClause = ` ORDER BY ${safeCol} ${safeDir}`;
    }
  }

  const offset = (page || 0) * (size || 10);
  const limit = size || 10;

  return {
    query: baseQuery + whereClause + orderClause + ` LIMIT ? OFFSET ?`,
    countQuery: countQuery + whereClause,
    params: [...params, ...filterParams, limit, offset],
    countParams: [...params, ...filterParams]
  };
}

function paginatedResponse(items, total, page, size) {
  return {
    content: items,
    totalElements: total,
    totalPages: Math.ceil(total / size),
    number: page,
    size
  };
}

module.exports = { buildPaginatedQuery, paginatedResponse };
