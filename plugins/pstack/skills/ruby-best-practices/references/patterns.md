# Ruby patterns

Code examples for each rule in `SKILL.md`. The underlying principles are language-agnostic. See the **model-the-domain**, **minimize-reader-load**, **type-system-discipline**, and **boundary-discipline** principle skills.

## `attr_reader` over ivars

```ruby
# Don't. Methods reach into ivars directly.
class PayRun
  def initialize(payslips)
    @payslips = payslips
  end

  def total
    @payslips.sum(&:net_pay)
  end
end

# Do. One reader, typed, private unless it's interface.
class PayRun
  extend T::Sig

  sig { params(payslips: T::Array[Payslip]).void }
  def initialize(payslips)
    @payslips = payslips
  end

  sig { returns(Money) }
  def total
    payslips.sum(&:net_pay)
  end

  private

  sig { returns(T::Array[Payslip]) }
  attr_reader :payslips
end
```

## No endless defs

```ruby
# Don't
def total = payslips.sum(&:net_pay)

# Do
def total
  payslips.sum(&:net_pay)
end
```

## No side-effect ivars

```ruby
# Don't. `parse` sets state that `rows` reads afterwards.
def rows
  parse
  @rows
end

# Do. The accessor memoises a returned value.
def rows
  @rows ||= parse
end
```

When `nil` or `false` is a valid result, `||=` runs the work again on every call:

```ruby
def manager
  return @manager if defined?(@manager)

  @manager = find_manager
end
```

## Keyword arguments

```ruby
# Don't. Which date is which, and what does `true` mean?
shifts_between(start_date, end_date, true)

# Do
shifts_between(from: start_date, to: end_date, include_vacant: true)
```

## Enums and exhaustive `case`

```ruby
# Don't. Any symbol fits, and a new state slips past every `case`.
def label(status)
  case status
  when :draft then "Draft"
  when :published then "Published"
  end
end

# Do
class ScheduleStatus < T::Enum
  enums do
    Draft = new
    Published = new
  end
end

sig { params(status: ScheduleStatus).returns(String) }
def label(status)
  case status
  when ScheduleStatus::Draft then "Draft"
  when ScheduleStatus::Published then "Published"
  else T.absurd(status)
  end
end
```

## Structs over hashes

```ruby
# Don't. Every caller has to know the keys.
def summary
  { hours: hours, cost: cost, team_id: team.id }
end

# Do
class TeamSummary < T::Struct
  const :hours, BigDecimal
  const :cost, Money
  const :team_id, Integer
end
```

## Parse at the boundary

```ruby
# Don't. Raw params travel into the domain and get checked everywhere.
def create
  RosterBuilder.new(params[:start], params[:team_ids]).build
end

# Do. Parse once into a typed object, then trust it.
def create
  RosterBuilder.new(roster_request).build
end

private

def roster_request
  RosterRequest.from_params(params.require(:roster).permit(:start, team_ids: []))
end
```

## Null object over `nil` checks

```ruby
# Don't
def display_name
  employee.manager ? employee.manager.name : "No manager"
end

# Do
class NoManager
  def name
    "No manager"
  end
end

def manager
  super || NoManager.new
end
```

## Tell, don't ask

```ruby
# Don't. The caller reads state and decides.
if timesheet.approved? && timesheet.user.payroll_enabled?
  timesheet.export!
end

# Do. The object owns the rule.
timesheet.export_if_ready
```

## Name the variation, don't pass it in a block

```ruby
# Don't. The shared method runs each caller's anonymous filter.
class VisibleSchedules
  def call(&filter)
    schedules.select { |schedule| visible?(schedule) && filter.call(schedule) }
  end
end

overview = VisibleSchedules.new(roster).call { |s| s.team_id.in?(team_ids) || s.vacant? }
stats    = VisibleSchedules.new(roster).call { |s| s.team_id.in?(team_ids) && s.costed? }

# Do. Return a relation, and let each caller chain named scopes.
class VisibleSchedules
  def relation
    roster.schedules.visible
  end
end

overview = VisibleSchedules.new(roster).relation.in_teams_or_vacant(team_ids)
stats    = VisibleSchedules.new(roster).relation.in_teams(team_ids).costed
```

When the variation isn't a query, name it as a method or a small object the shared code calls, instead of a block it receives.

```ruby
# Don't
def export(&row_builder)
  CSV.generate { |csv| rows.each { |row| csv << row_builder.call(row) } }
end

# Do
def export(format:)
  CSV.generate { |csv| rows.each { |row| csv << format.columns(row) } }
end

export(format: PayrollColumns.new)
```

Blocks remain the right tool when the method wraps setup and teardown around work the caller owns:

```ruby
Schedule.transaction do
  schedule.update!(published: true)
  schedule.breaks.each(&:publish!)
end
```

## No queries in views

```erb
<%# Don't. One query per row. %>
<% @teams.each do |team| %>
  <%= team.employees.active.count %>
<% end %>
```

```ruby
# Do. Load in the controller, pass the result in.
def index
  @overview = TeamOverview.new(teams: current_org.teams.includes(:active_employees))
end
```

## Tests grouped by method

```ruby
# Do
context "#allowance_for" do
  test "a percentage is taken from the target" do
  end

  test "a non-percentage unit is the allowance itself" do
  end
end

test "#total - sums net pay" do
end

# Don't. The method name repeats inside its own context.
context "#allowance_for" do
  test "#allowance_for - a percentage is taken from the target" do
  end
end

# Don't. Nested contexts.
context "#allowance_for" do
  context "with a percentage" do
  end
end
```
