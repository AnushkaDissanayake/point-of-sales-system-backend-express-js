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

    if (sqlOp) {
      // Multi-column OR search: filterColumn = "name~@item_code" searches name OR item_code.
      // filterValue may be a single term shared by every column, or the same "~"-joined shape
      // (one value per column) mirroring how filterColumn was built on the client.
      const columnParts = String(filterColumn).split('~').map(p => p.trim()).filter(Boolean);
      const rawValueParts = String(filterValue).split('~');
      const valueParts = rawValueParts.length === columnParts.length ? rawValueParts : columnParts.map(() => filterValue);

      const resolvedPairs = columnParts.map((part, idx) => {
        const raw = part.startsWith('@') ? part.substring(1) : part;
        let safeColumn = allowedColumns && allowedColumns.includes(raw) ? raw : null;
        if (safeColumn && !safeColumn.includes('.')) {
          const prefixed = allowedColumns.find(c => c.endsWith(`.${safeColumn}`));
          if (prefixed) safeColumn = prefixed;
        }
        return safeColumn ? { column: safeColumn, value: valueParts[idx] } : null;
      }).filter(Boolean);

      if (resolvedPairs.length > 0) {
        const clauses = resolvedPairs.map(({ column, value }) => {
          const isIdCol = column.endsWith('_id') || column === 'id' || column.endsWith('.id');
          if (isIdCol) {
            filterParams.push(parseInt(String(value).replace(/%/g, '')) || 0);
            return `${column} = ?`;
          }
          let val = value;
          if (operator === 'CONTAINS' || operator.toLowerCase() === 'like') {
            val = `%${value}%`;
          } else if (operator === 'STARTS_WITH') {
            val = `${value}%`;
          } else if (operator === 'ENDS_WITH') {
            val = `%${value}`;
          }
          filterParams.push(String(val).toLowerCase());
          return `LOWER(${column}) ${sqlOp} ?`;
        });
        whereClause = resolvedPairs.length > 1 ? ` AND (${clauses.join(' OR ')})` : ` AND ${clauses[0]}`;
      }
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

// Rewrites friendly/DTO-facing column names in a (possibly multi-column,
// "~"-joined) filterColumn to their real underlying table column, e.g.
// "contact" -> "contact_number", "name~@contact" -> "name~@contact_number".
// Route handlers use this so clients can keep filtering by the same field
// names the response DTO exposes, without those aliases needing to be
// treated as real, filterable table columns everywhere else.
function aliasFilterColumn(filterColumn, aliasMap) {
  if (!filterColumn) return filterColumn;
  return String(filterColumn).split('~').map(part => {
    const prefix = part.startsWith('@') ? '@' : '';
    const name = prefix ? part.slice(1) : part;
    return prefix + (aliasMap[name] || name);
  }).join('~');
}

module.exports = { buildPaginatedQuery, paginatedResponse, aliasFilterColumn };
