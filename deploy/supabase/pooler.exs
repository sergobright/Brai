{:ok, _} = Application.ensure_all_started(:supavisor)

{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

base_params = %{
  "db_host" => System.get_env("POSTGRES_HOST") || "db",
  "db_port" => System.get_env("POSTGRES_PORT"),
  "db_database" => System.get_env("POSTGRES_DB"),
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => System.get_env("POOLER_MAX_CLIENT_CONN"),
  "default_pool_size" => System.get_env("POOLER_DEFAULT_POOL_SIZE"),
  "default_parameter_status" => %{"server_version" => version},
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => System.get_env("POSTGRES_PASSWORD"),
    "mode_type" => System.get_env("POOLER_POOL_MODE"),
    "pool_size" => System.get_env("POOLER_DEFAULT_POOL_SIZE"),
    "is_manager" => true
  }]
}

[System.get_env("POOLER_TENANT_ID"), "brai-prod", "brai-nonprod"]
|> Enum.reject(&(&1 in [nil, ""]))
|> Enum.uniq()
|> Enum.each(fn external_id ->
  if !Supavisor.Tenants.get_tenant_by_external_id(external_id) do
    {:ok, _} = Supavisor.Tenants.create_tenant(Map.put(base_params, "external_id", external_id))
  end
end)
