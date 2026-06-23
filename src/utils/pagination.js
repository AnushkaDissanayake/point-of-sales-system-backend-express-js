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
    'LESS_THAN_OR_EQUALS': '<='
  };

  let whereClause = '';
  let filterParams = [];

  if (filterColumn && operator && filterValue !== undefined && filterValue !== '') {
    const sqlOp = validOperators[operator];
    const safeColumn = allowedColumns && allowedColumns.includes(filterColumn) ? filterColumn : null;
    if (sqlOp && safeColumn) {
      let val = filterValue;
      if (operator === 'CONTAINS') val = `%${filterValue}%`;
      else if (operator === 'STARTS_WITH') val = `${filterValue}%`;
      else if (operator === 'ENDS_WITH') val = `%${filterValue}`;
      whereClause = ` AND ${safeColumn} ${sqlOp} ?`;
      filterParams = [val];
    }
  }

  let orderClause = '';
  if (sorting) {
    const [col, dir] = sorting.split(',');
    const safeCol = allowedColumns && allowedColumns.includes(col) ? col : null;
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
