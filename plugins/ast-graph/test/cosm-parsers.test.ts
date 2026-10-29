import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AstGraphDatabase,
  AstGraphIndexer,
  ContractCompilerAdapter,
  DockerfileCompilerAdapter,
  GoCompilerAdapter,
  PolyglotCompilerAdapter,
  PythonCompilerAdapter,
  RustCompilerAdapter,
  SqlCompilerAdapter,
  TerraformCompilerAdapter,
} from '../src/index.js';

const tempDirs: string[] = [];

function makeTempWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('cosm parser evaluations, upgrades, and polyglot ports', () => {
  it('upgrades SQL adapter with dollar-quoted strings, multi-word types, FK REFERENCES, and CREATE VIEW lineage', () => {
    const ws = makeTempWorkspace('ast-sql-cosm-');
    const sqlContent = [
      '-- Migration 001',
      'CREATE OR REPLACE FUNCTION TouchUpdatedAt() RETURNS TRIGGER AS $$',
      'BEGIN',
      '  NEW.updated_at := NOW(); -- semicolon inside $$ body!',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '',
      'CREATE TABLE public.users (',
      '  id UUID NOT NULL PRIMARY KEY,',
      '  email CHARACTER VARYING(255) NOT NULL,',
      '  balance NUMERIC(12, 2) DEFAULT 0.00,',
      '  created_at TIMESTAMP WITH TIME ZONE NOT NULL',
      ');',
      '',
      'CREATE TABLE public.orders (',
      '  order_id UUID NOT NULL PRIMARY KEY,',
      '  user_id UUID NOT NULL REFERENCES public.users(id),',
      '  total DOUBLE PRECISION NOT NULL,',
      '  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users (id)',
      ') INTERLEAVE IN PARENT users ON DELETE CASCADE;',
      '',
      'CREATE VIEW public.active_user_orders AS',
      '  SELECT u.email, o.order_id, o.total',
      '  FROM public.users u',
      '  JOIN public.orders o ON o.user_id = u.id;',
      '',
      'CREATE INDEX idx_orders_user ON public.orders (user_id);',
    ].join('\n');

    fs.writeFileSync(path.join(ws, 'schema.sql'), sqlContent, 'utf8');

    const adapter = new SqlCompilerAdapter();
    const batch = adapter.extract(ws);

    const usersTable = batch.nodes.find((n) => n.id === 'scip-sql ddl sql 1.0.0 table:users#');
    expect(usersTable).toBeDefined();
    expect(usersTable?.startLine).toBe(9);
    expect(usersTable?.endLine).toBe(14);

    const emailCol = batch.nodes.find((n) => n.id === 'scip-sql ddl sql 1.0.0 table:users#email.');
    expect(emailCol?.properties.columnType).toBe('CHARACTER VARYING(255)');
    expect(emailCol?.properties.notNull).toBe(true);

    const balanceCol = batch.nodes.find((n) => n.id === 'scip-sql ddl sql 1.0.0 table:users#balance.');
    expect(balanceCol?.properties.columnType).toBe('NUMERIC(12, 2)');

    const ordersTable = batch.nodes.find((n) => n.id === 'scip-sql ddl sql 1.0.0 table:orders#');
    expect(ordersTable).toBeDefined();
    expect(ordersTable?.startLine).toBe(16);
    expect(ordersTable?.endLine).toBe(21);

    // Foreign key + INTERLEAVE IN PARENT -> REFERENCES users
    const orderRefsUsers = batch.edges.filter(
      (e) =>
        e.srcId === 'scip-sql ddl sql 1.0.0 table:orders#' &&
        e.dstId === 'scip-sql ddl sql 1.0.0 table:users#' &&
        e.kind === 'REFERENCES',
    );
    expect(orderRefsUsers.length).toBeGreaterThanOrEqual(1);

    // View -> REFERENCES users & orders
    const viewNode = batch.nodes.find((n) => n.id === 'scip-sql ddl sql 1.0.0 view:active_user_orders#');
    expect(viewNode).toBeDefined();
    expect(viewNode?.startLine).toBe(23);
    expect(viewNode?.endLine).toBe(26);

    const viewRefs = batch.edges
      .filter((e) => e.srcId === viewNode?.id && e.kind === 'REFERENCES')
      .map((e) => e.dstId);
    expect(viewRefs).toContain('scip-sql ddl sql 1.0.0 table:users#');
    expect(viewRefs).toContain('scip-sql ddl sql 1.0.0 table:orders#');
  });

  it('upgrades Terraform/HCL adapter with heredocs, block comments, modules, .tfvars, container image, and env vars', () => {
    const ws = makeTempWorkspace('ast-tf-cosm-');
    const tfContent = [
      '/* Multi-line comment',
      '   with { fake braces } */',
      'variable "project_id" {',
      '  type    = string',
      '  default = "davenport-boutique"',
      '}',
      '',
      'resource "google_cloud_run_v2_service" "api" {',
      '  name     = "boutique-api"',
      '  location = "us-central1"',
      '  description = <<EOF',
      '    Unbalanced { brace inside heredoc',
      'EOF',
      '  template {',
      '    containers {',
      '      image = "us-central1-docker.pkg.dev/davenport-boutique/app/api:latest"',
      '      env {',
      '        name  = "DATABASE_URL"',
      '        value = var.project_id',
      '      }',
      '    }',
      '  }',
      '}',
      '',
      'module "network" {',
      '  source = "./modules/vpc"',
      '}',
    ].join('\n');

    fs.writeFileSync(path.join(ws, 'main.tf'), tfContent, 'utf8');
    fs.writeFileSync(path.join(ws, 'prod.tfvars'), 'project_id = "davenport-boutique"\n', 'utf8');

    const adapter = new TerraformCompilerAdapter();
    const batch = adapter.extract(ws);

    const runService = batch.nodes.find((n) => n.name === 'google_cloud_run_v2_service.api');
    expect(runService).toBeDefined();
    expect(runService?.startLine).toBe(8);
    expect(runService?.endLine).toBe(23);

    const moduleNode = batch.nodes.find((n) => n.name === 'module.network');
    expect(moduleNode).toBeDefined();
    expect(moduleNode?.startLine).toBe(25);
    expect(moduleNode?.endLine).toBe(27);

    const envEdge = batch.edges.find(
      (e) =>
        e.srcId === runService?.id &&
        e.dstId === 'scip-env global env 1.0.0 DATABASE_URL#' &&
        e.kind === 'CONFIGURES_ENV',
    );
    expect(envEdge).toBeDefined();

    const tfvarsVar = batch.nodes.find((n) => n.filePath === 'prod.tfvars' && n.name === 'var.project_id');
    expect(tfvarsVar).toBeDefined();
  });

  it('upgrades Go and Python adapters with Go generics, Gin routes, and CONFIGURES_ENV lineage', () => {
    const ws = makeTempWorkspace('ast-go-py-cosm-');
    fs.writeFileSync(
      path.join(ws, 'server.go'),
      [
        'package main',
        '',
        'import "os"',
        '',
        'func MapSlice[T any, R any](items []T, fn func(T) R) []R {',
        '  return nil',
        '}',
        '',
        'func StartServer(r *Router) {',
        '  dbUrl := os.Getenv("DATABASE_URL")',
        '  _ = dbUrl',
        '  r.GET("/v1/orders", ListOrders)',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'app.py'),
      [
        'import os',
        '',
        'def load_config() -> str:',
        '    db = os.getenv("DATABASE_URL")',
        '    secret = os.environ.get("JWT_SECRET")',
        '    return f"{db}:{secret}"',
      ].join('\n'),
      'utf8',
    );

    const goBatch = new GoCompilerAdapter().extract(ws);
    const genericFn = goBatch.nodes.find((n) => n.name === 'MapSlice');
    expect(genericFn).toBeDefined();
    expect(genericFn?.startLine).toBe(5);
    expect(genericFn?.endLine).toBe(7);

    const goEnvEdge = goBatch.edges.find(
      (e) => e.dstId === 'scip-env global env 1.0.0 DATABASE_URL#' && e.kind === 'CONFIGURES_ENV',
    );
    expect(goEnvEdge).toBeDefined();

    const ginRouteEdge = goBatch.edges.find(
      (e) => e.dstId === 'scip-endpoint http GET:/v1/orders#' && e.kind === 'HANDLES_ROUTE',
    );
    expect(ginRouteEdge).toBeDefined();

    const pyBatch = new PythonCompilerAdapter().extract(ws);
    const pyEnvEdges = pyBatch.edges.filter((e) => e.kind === 'CONFIGURES_ENV').map((e) => e.dstId);
    expect(pyEnvEdges).toContain('scip-env global env 1.0.0 DATABASE_URL#');
    expect(pyEnvEdges).toContain('scip-env global env 1.0.0 JWT_SECRET#');
  });

  it('ports Dockerfile adapter with multi-stage builds, COPY --from, ENV/ARG, EXPOSE, and line continuations', () => {
    const ws = makeTempWorkspace('ast-docker-cosm-');
    fs.writeFileSync(
      path.join(ws, 'Dockerfile'),
      [
        'FROM golang:1.23-alpine AS builder',
        'ARG BUILD_VERSION=1.0.0',
        'WORKDIR /src',
        'RUN go build \\',
        '    -o /out/server \\',
        '    ./cmd/server',
        '',
        'FROM gcr.io/distroless/base-debian12 AS runtime',
        'ENV PORT=8080 DATABASE_URL="postgres://localhost/db"',
        'COPY --from=builder /out/server /server',
        'EXPOSE 8080/tcp',
        'ENTRYPOINT ["/server"]',
      ].join('\n'),
      'utf8',
    );

    const batch = new DockerfileCompilerAdapter().extract(ws);
    const builderStage = batch.nodes.find((n) => n.name === 'builder');
    const runtimeStage = batch.nodes.find((n) => n.name === 'runtime');
    expect(builderStage).toBeDefined();
    expect(builderStage?.startLine).toBe(1);
    expect(builderStage?.endLine).toBe(7);
    expect(runtimeStage).toBeDefined();
    expect(runtimeStage?.startLine).toBe(8);
    expect(runtimeStage?.endLine).toBe(12);

    const copyFromEdge = batch.edges.find(
      (e) => e.srcId === runtimeStage?.id && e.dstId === builderStage?.id && e.kind === 'REFERENCES',
    );
    expect(copyFromEdge).toBeDefined();

    const envPort = batch.nodes.find((n) => n.id === 'scip-env global env 1.0.0 PORT#');
    expect(envPort).toBeDefined();

    const exposeNode = batch.nodes.find((n) => n.id === 'scip-endpoint port EXPOSE:8080/tcp#');
    expect(exposeNode).toBeDefined();
  });

  it('ports Contract adapter for Protobuf (.proto) and GraphQL (.graphql) with exact multi-line spans and schema edges', () => {
    const ws = makeTempWorkspace('ast-contract-cosm-');
    fs.writeFileSync(
      path.join(ws, 'orders.proto'),
      [
        'syntax = "proto3";',
        'package boutique.v1;',
        '',
        '/* Block comment with',
        '   service FakeService {} */',
        'service OrderService {',
        '  rpc CreateOrder (CreateOrderRequest) returns (OrderResponse) {',
        '    option (google.api.http) = {',
        '      post: "/v1/orders"',
        '      body: "*"',
        '    };',
        '  }',
        '}',
        '',
        'message CreateOrderRequest {',
        '  string user_id = 1;',
        '  repeated OrderItem items = 2;',
        '}',
        '',
        'message OrderItem {',
        '  string sku = 1;',
        '}',
        '',
        'message OrderResponse {',
        '  string order_id = 1;',
        '  OrderStatus status = 2;',
        '}',
        '',
        'enum OrderStatus {',
        '  ORDER_STATUS_UNSPECIFIED = 0;',
        '  ORDER_STATUS_CREATED = 1;',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'schema.graphql'),
      [
        'interface Node {',
        '  id: ID!',
        '}',
        '',
        'type Order implements Node {',
        '  id: ID!',
        '  total: Float!',
        '}',
        '',
        'input CreateOrderInput {',
        '  userId: ID!',
        '}',
        '',
        'type Mutation {',
        '  createOrder(input: CreateOrderInput!): Order!',
        '}',
      ].join('\n'),
      'utf8',
    );

    const batch = new ContractCompilerAdapter().extract(ws);

    const protoSvc = batch.nodes.find((n) => n.name === 'OrderService');
    expect(protoSvc?.startLine).toBe(6);
    expect(protoSvc?.endLine).toBe(13);

    const rpcNode = batch.nodes.find((n) => n.name === 'CreateOrder');
    expect(rpcNode?.startLine).toBe(7);
    expect(rpcNode?.endLine).toBe(12);

    // Protobuf RPC -> HTTP RouteEndpoint, VALIDATES_SCHEMA, EMITS_SCHEMA
    expect(
      batch.edges.some(
        (e) =>
          e.srcId === rpcNode?.id &&
          e.dstId === 'scip-endpoint http POST:/v1/orders#' &&
          e.kind === 'HANDLES_ROUTE',
      ),
    ).toBe(true);
    expect(batch.edges.some((e) => e.srcId === rpcNode?.id && e.kind === 'VALIDATES_SCHEMA')).toBe(true);
    expect(batch.edges.some((e) => e.srcId === rpcNode?.id && e.kind === 'EMITS_SCHEMA')).toBe(true);

    // GraphQL type Order implements Node
    const gqlOrder = batch.nodes.find((n) => n.filePath === 'schema.graphql' && n.name === 'Order');
    const gqlNodeIface = batch.nodes.find((n) => n.filePath === 'schema.graphql' && n.name === 'Node');
    expect(gqlOrder?.startLine).toBe(5);
    expect(gqlOrder?.endLine).toBe(8);
    expect(
      batch.edges.some(
        (e) => e.srcId === gqlOrder?.id && e.dstId === gqlNodeIface?.id && e.kind === 'IMPLEMENTS',
      ),
    ).toBe(true);
  });

  it('ports Rust adapter with lifetime-safe brace scanning, traits, impls, Actix/Axum routes, and sqlx lineage', () => {
    const ws = makeTempWorkspace('ast-rust-cosm-');
    fs.writeFileSync(
      path.join(ws, 'lib.rs'),
      [
        'use std::env;',
        '',
        'pub trait Repository {',
        '    fn find_user(&self, id: &str) -> Option<String>;',
        '}',
        '',
        'pub struct PgRepo {',
        '    pub pool_url: String,',
        '}',
        '',
        'impl Repository for PgRepo {',
        "    fn find_user<'a>(&'a self, id: &'a str) -> Option<String> {",
        '        let raw = r#"{"unbalanced": "{"}"#;',
        "        let ch = '{';",
        '        let _ = env::var("DATABASE_URL");',
        '        let _ = sqlx::query!("SELECT id FROM users WHERE id = $1", id);',
        '        Some(raw.to_string() + &ch.to_string())',
        '    }',
        '}',
        '',
        '#[get("/v1/users")]',
        'pub async fn list_users() -> String {',
        '    String::from("ok")',
        '}',
        '',
        '#[tokio::test]',
        'async fn test_list_users() {',
        '    let _ = list_users();',
        '}',
      ].join('\n'),
      'utf8',
    );

    const batch = new RustCompilerAdapter().extract(ws);

    const traitNode = batch.nodes.find((n) => n.name === 'Repository' && n.kind === 'Interface');
    expect(traitNode?.startLine).toBe(3);
    expect(traitNode?.endLine).toBe(5);

    const structNode = batch.nodes.find((n) => n.name === 'PgRepo' && n.kind === 'Class');
    expect(structNode?.startLine).toBe(7);
    expect(structNode?.endLine).toBe(9);

    const implEdge = batch.edges.find(
      (e) => e.srcId === structNode?.id && e.dstId === traitNode?.id && e.kind === 'IMPLEMENTS',
    );
    expect(implEdge).toBeDefined();

    // Verify lifetime `'a` + raw string `r#"...{..."#` + char literal `'{'` did NOT break method endLine
    const findUserMethod = batch.nodes.find(
      (n) => n.qualifiedName === 'PgRepo::find_user' && n.kind === 'Method',
    );
    expect(findUserMethod?.startLine).toBe(12);
    expect(findUserMethod?.endLine).toBe(18);

    // Actix route, env var, sqlx table, and test case
    expect(
      batch.edges.some(
        (e) => e.dstId === 'scip-endpoint http GET:/v1/users#' && e.kind === 'HANDLES_ROUTE',
      ),
    ).toBe(true);
    expect(
      batch.edges.some(
        (e) => e.dstId === 'scip-env global env 1.0.0 DATABASE_URL#' && e.kind === 'CONFIGURES_ENV',
      ),
    ).toBe(true);
    expect(
      batch.edges.some(
        (e) => e.dstId === 'scip-sql ddl sql 1.0.0 table:users#' && e.kind === 'REFERENCES',
      ),
    ).toBe(true);

    const testNode = batch.nodes.find((n) => n.name === 'test_list_users' && n.kind === 'TestCase');
    expect(testNode).toBeDefined();
  });

  it('ports Polyglot adapter across Java, Kotlin, C#, Ruby, Elixir, PHP, C++, Swift, Zig, and WASM/WIT', () => {
    const ws = makeTempWorkspace('ast-polyglot-cosm-');

    fs.writeFileSync(
      path.join(ws, 'OrderController.java'),
      [
        'package com.boutique;',
        '@Table(name = "orders")',
        'public class OrderController {',
        '  @GetMapping("/v1/orders")',
        '  public String listOrders() {',
        '    String db = System.getenv("DATABASE_URL");',
        '    return db;',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'Service.kt'),
      [
        'package com.boutique',
        'class OrderService : BaseService {',
        '  suspend fun fetchOrder(id: String): String {',
        '    return id',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'OrdersController.cs'),
      [
        'namespace Boutique.Api;',
        '[Table("orders")]',
        'public class OrdersController : ControllerBase {',
        '  [HttpPost("/v1/orders")]',
        '  public string CreateOrder() {',
        '    return "ok";',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'order.rb'),
      [
        'class Order < ApplicationRecord',
        '  belongs_to :user',
        '  def total_cents',
        '    ENV["CURRENCY"]',
        '  end',
        'end',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'user.ex'),
      [
        'defmodule Boutique.User do',
        '  schema "users" do',
        '    field :email, :string',
        '  end',
        '  def changeset(user, attrs) do',
        '    {user, attrs}',
        '  end',
        'end',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'UserController.php'),
      [
        '<?php',
        'namespace App\\Controller;',
        'class UserController {',
        "  #[Route('/v1/users', methods: ['GET'])]",
        '  public function index(): string {',
        '    return "ok";',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'engine.cpp'),
      [
        'namespace boutique {',
        'class PricingEngine : public BaseEngine {',
        'public:',
        '  double computePrice(int qty) {',
        '    return qty * 9.99;',
        '  }',
        '};',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'Store.swift'),
      [
        'public actor OrderStore: Sendable {',
        '  public func count() -> Int {',
        '    return 42',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'math.zig'),
      [
        'pub const Vector = struct {',
        '    x: f32,',
        '};',
        'pub fn add(a: i32, b: i32) i32 {',
        '    return a + b;',
        '}',
        'test "addition works" {',
        '    _ = add(1, 2);',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(ws, 'checkout.wit'),
      [
        'interface checkout {',
        '  charge: func(amount: u64) -> bool;',
        '}',
      ].join('\n'),
      'utf8',
    );

    const dbPath = path.join(ws, '.ast-graph', 'ast.db');
    const indexer = new AstGraphIndexer(ws, new AstGraphDatabase(dbPath));
    const syncRes = indexer.syncWorkspace({ full: true });
    expect(syncRes.filesUpdated).toBe(10);

    // Verify all 10 polyglot languages produced indexed symbols in SQLite
    const outlineJava = indexer.db.getFileOutline('OrderController.java');
    expect(outlineJava.symbols.some((n) => n.name === 'OrderController' && n.startLine === 3 && n.endLine === 9)).toBe(true);

    const outlineRuby = indexer.db.getFileOutline('order.rb');
    expect(outlineRuby.symbols.some((n) => n.name === 'Order' && n.startLine === 1 && n.endLine === 6)).toBe(true);

    const outlineElixir = indexer.db.getFileOutline('user.ex');
    expect(outlineElixir.symbols.some((n) => n.name === 'Boutique.User' && n.startLine === 1 && n.endLine === 8)).toBe(true);

    const outlineZig = indexer.db.getFileOutline('math.zig');
    expect(outlineZig.symbols.some((n) => n.name === 'addition works' && n.kind === 'TestCase')).toBe(true);

    const outlineWit = indexer.db.getFileOutline('checkout.wit');
    expect(outlineWit.symbols.some((n) => n.name === 'charge' && n.kind === 'Function')).toBe(true);

    indexer.db.close();
  });
});
